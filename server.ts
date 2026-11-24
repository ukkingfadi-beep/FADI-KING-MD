import fs from 'fs';
import path from 'path';
import express from 'express';
import JSZip from 'jszip';
import { isValidPhone, loadConfig, normalizePhone, saveConfig } from './config/bot.config.ts';
import { findCommand, getAllCommands } from './commands/index.ts';
import {
  applyAlwaysOnlinePresenceAcrossSockets,
  applySingleTickPresenceAcrossSockets,
  closeAllSocketsGracefully,
  disconnectMainBot,
  getBotSnapshot,
  getPreferredActiveSocket,
  initializeSavedSessionOnBoot,
  requestVipSubPairingCode,
  resolveNewsletterMetadataFromActiveSockets,
  restartMainBot,
  sendDashboardBroadcast,
  startMainBot,
  syncAutoJoinsAcrossConnectedSessions,
} from './handlers/connection.ts';
import { executeConsoleCommand } from './handlers/message.ts';
import {
  createAdminSession,
  extractTokenFromRequest,
  isValidAdminToken,
  requireAdmin,
  revokeAdminToken,
  verifyAdminPassword,
} from './utils/adminAuth.ts';
import { liveStore, type AlertLevel } from './utils/liveStore.ts';
import { anticallStore } from './utils/anticallStore.ts';
import { crashGuardStore } from './utils/crashGuard.ts';
import { initDatabase } from './utils/db.ts';
import { logger } from './utils/logger.ts';
import { pairingRateLimiter } from './utils/rateLimiter.ts';
import {
  executeMultiReport,
  reportStore,
  sendTestSmtpEmail,
  type ReportActionType,
} from './utils/reportStore.ts';
import { vipStore, type VipTier } from './utils/vipStore.ts';

// Global process crash protection so a single async error never kills the bot
process.on('uncaughtException', (err) => {
  logger.error('process', `Uncaught exception caught: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error('process', `Unhandled rejection caught: ${msg}`);
});

const SOURCE_FILES = [
  'config/bot.config.ts',
  'handlers/connection.ts',
  'handlers/message.ts',
  'handlers/group.ts',
  'commands/types.ts',
  'commands/index.ts',
  'commands/general.ts',
  'commands/vip.ts',
  'commands/group.ts',
  'commands/media.ts',
  'commands/owner.ts',
  'utils/vipStore.ts',
  'utils/rateLimiter.ts',
  'utils/mediaHelper.ts',
  'utils/socialDownloader.ts',
  'utils/logger.ts',
  'utils/jidHelper.ts',
  'utils/adminAuth.ts',
  'utils/liveStore.ts',
  'utils/anticallStore.ts',
  'utils/crashGuard.ts',
  'utils/reportStore.ts',
  'utils/chatHistoryStore.ts',
  'utils/reminderStore.ts',
  'utils/geminiService.ts',
  'utils/db.ts',
  'server.ts',
  '.env.example',
  'package.json',
  'README.md',
];

async function startServer(): Promise<void> {
  const app = express();
  const envPort = Number(process.env.PORT || 0);
  const nginxPort = Number(process.env.NGINX_PORT || 0);
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT || 3000);
  const hasExplicitProdPort = envPort > 0 && envPort !== nginxPort;
  const isDev =
    process.env.NODE_ENV === 'development' ||
    (process.env.NODE_ENV !== 'production' && !hasExplicitProdPort);
  const port = isDev ? defaultAppPort : hasExplicitProdPort ? envPort : defaultAppPort;

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '35mb' }));

  // ============================================================================
  // PUBLIC ENDPOINTS (Pairing System + Live Screen + Bell Alerts + Admin Login)
  // ============================================================================

  app.get('/health', (_req, res) => {
    const snap = getBotSnapshot();
    const activeConnected =
      snap.status === 'connected' || snap.subSessions.some((s) => s.status === 'connected');
    res.json({ ok: true, connected: activeConnected, uptimeSeconds: snap.uptimeSeconds });
  });

  app.get('/api/health', (_req, res) => {
    const snap = getBotSnapshot();
    const activeConnected =
      snap.status === 'connected' || snap.subSessions.some((s) => s.status === 'connected');
    res.json({ ok: true, connected: activeConnected, uptimeSeconds: snap.uptimeSeconds });
  });

  let readyError: Error | null = null;
  let viteMiddleware: express.RequestHandler | null = null;
  let viteInstance: { close: () => Promise<void> } | null = null;

  const readyPromise = (async () => {
    const dbInitPromise = initDatabase().then(() => {
      initializeSavedSessionOnBoot();
    });

    if (isDev) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true, hmr: false, ws: false },
        appType: 'spa',
      });
      viteInstance = vite;
      viteMiddleware = vite.middlewares;
    }

    await dbInitPromise;
  })().catch((err) => {
    readyError = err instanceof Error ? err : new Error(String(err));
    logger.error('server', `Startup initialization failed: ${readyError.message}`);
  });

  app.use(async (_req, res, next) => {
    await readyPromise;
    if (readyError) {
      return res.status(500).json({ ok: false, error: readyError.message });
    }
    return next();
  });

  app.get('/api/public/state', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const cfg = loadConfig();
    const snap = getBotSnapshot();
    const combined = vipStore.getCombinedActiveUsers(snap);

    res.json({
      bot: {
        status: snap.status === 'qr_ready' || snap.status === 'pairing_ready' || snap.status === 'connecting' ? snap.status : 'idle',
        qrDataUrl: snap.qrDataUrl,
        pairingCode: snap.pairingCode,
        vipOnlyPairing: cfg.vipOnlyPairing,
        prefix: cfg.prefix,
        botName: cfg.botName,
        activePaidUsersCount: combined.activePaidUsersCount,
      },
      portalBanner: liveStore.getPortalBanner(),
      liveScreen: liveStore.getLiveScreen(),
      alerts: liveStore.getAlerts(25),
    });
  });

  app.get('/api/bot/pair-status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const cleanPhone = normalizePhone(String(req.query?.phone || ''));
    if (!isValidPhone(cleanPhone)) {
      return res.json({ status: 'idle' });
    }
    const snap = getBotSnapshot();
    const sub = snap.subSessions.find((s) => s.phone === cleanPhone);
    if (sub) {
      return res.json({ status: sub.status });
    }
    if (snap.connectedUser?.phone === cleanPhone && snap.status === 'connected') {
      return res.json({ status: 'connected' });
    }
    return res.json({ status: snap.pairingPhone === cleanPhone ? snap.status : 'idle' });
  });

  app.get('/api/public/media/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename || '');
    if (!safeName || safeName.includes('..')) {
      return res.status(400).end();
    }
    const fullPath = path.join(liveStore.getMediaDir(), safeName);
    if (fs.existsSync(fullPath)) {
      return res.sendFile(fullPath);
    }
    const persisted = liveStore.readPersistedMedia(safeName);
    if (persisted) {
      res.setHeader('Content-Type', persisted.mimeType);
      return res.send(persisted.buffer);
    }
    return res.status(404).end();
  });

  app.post('/api/bot/start-qr', async (_req, res) => {
    try {
      await startMainBot();
      res.json({ ok: true, message: 'WhatsApp MD socket initialized for QR pairing.' });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/bot/pair-code', async (req, res) => {
    try {
      const cfg = loadConfig();
      const rawPhone = String(req.body?.phone || '');
      const accessToken = String(req.body?.token || '');
      const targetMode = req.body?.target === 'main' ? 'main' : 'vip';
      const cleanPhone = normalizePhone(rawPhone);

      if (!isValidPhone(cleanPhone)) {
        return res.status(400).json({
          ok: false,
          error: 'Enter a valid WhatsApp phone number with country code (8-15 digits, e.g. 923169760375).',
        });
      }

      const clientIp = req.ip || 'local';
      const ipRate = pairingRateLimiter.check(
        `ip:${clientIp}`,
        Math.max(300, cfg.maxPairAttempts * 50),
        cfg.pairWindowMinutes
      );
      if (!ipRate.allowed) {
        vipStore.logPairingAttempt({
          number: cleanPhone,
          status: 'rate_limited',
          reason: `IP burst limit reached. Cooldown ${ipRate.retryAfterSeconds}s`,
          source: 'dashboard',
        });
        logger.security('safetyGuard', `Blocked IP pairing flood from ${clientIp} (${ipRate.retryAfterSeconds}s cooldown)`);
        return res.status(429).json({
          ok: false,
          code: 'RATE_LIMITED',
          retryAfterSeconds: ipRate.retryAfterSeconds,
          error: `Too many pairing requests. Cooldown active for ${ipRate.retryAfterSeconds}s.`,
        });
      }

      // Check VIP authorization before consuming the phone's 60s pairing cooldown
      const auth = vipStore.isAuthorizedForPairing(cleanPhone, accessToken);
      if (!auth.authorized) {
        const unauthRate = pairingRateLimiter.check(
          `unauth:${clientIp}:${cleanPhone}`,
          5,
          cfg.pairWindowMinutes
        );
        if (!unauthRate.allowed) {
          vipStore.logPairingAttempt({
            number: cleanPhone,
            status: 'rate_limited',
            reason: `Unauthorized retry limit reached. Cooldown ${unauthRate.retryAfterSeconds}s`,
            source: 'dashboard',
          });
          return res.status(429).json({
            ok: false,
            code: 'RATE_LIMITED',
            retryAfterSeconds: unauthRate.retryAfterSeconds,
            error: `Too many unauthorized attempts for +${cleanPhone}. Wait ${unauthRate.retryAfterSeconds}s.`,
          });
        }

        vipStore.logPairingAttempt({
          number: cleanPhone,
          status: 'denied',
          reason: auth.reason,
          source: 'dashboard',
        });
        logger.security('vipGate', `Denied unauthorized pairing attempt for +${cleanPhone}`);
        return res.status(403).json({
          ok: false,
          code: 'VIP_REQUIRED',
          error: auth.reason,
        });
      }

      const pairCooldown = pairingRateLimiter.checkCooldown(
        `pair-cd:${cleanPhone}`,
        cfg.pairCooldownSeconds
      );
      if (!pairCooldown.allowed) {
        vipStore.logPairingAttempt({
          number: cleanPhone,
          status: 'rate_limited',
          reason: `Pairing cooldown active (${pairCooldown.retryAfterSeconds}s remaining)`,
          source: 'dashboard',
        });
        logger.warn(
          'safetyGuard',
          `Pairing cooldown enforced for +${cleanPhone} (${pairCooldown.retryAfterSeconds}s remaining)`
        );
        return res.status(429).json({
          ok: false,
          code: 'PAIR_COOLDOWN',
          retryAfterSeconds: pairCooldown.retryAfterSeconds,
          error: `Cooldown active for +${cleanPhone}. Wait ${pairCooldown.retryAfterSeconds}s before requesting another code.`,
        });
      }

      const phoneRate = pairingRateLimiter.check(
        `phone:${cleanPhone}`,
        cfg.maxPairAttempts,
        cfg.pairWindowMinutes
      );
      if (!phoneRate.allowed) {
        vipStore.logPairingAttempt({
          number: cleanPhone,
          status: 'rate_limited',
          reason: `Phone window limit reached. Cooldown ${phoneRate.retryAfterSeconds}s`,
          source: 'dashboard',
        });
        logger.security('safetyGuard', `Blocked pairing flood for +${cleanPhone} (${phoneRate.retryAfterSeconds}s cooldown)`);
        return res.status(429).json({
          ok: false,
          code: 'RATE_LIMITED',
          retryAfterSeconds: phoneRate.retryAfterSeconds,
          error: `Too many pairing requests for +${cleanPhone}. Cooldown active for ${phoneRate.retryAfterSeconds}s.`,
        });
      }

      if (phoneRate.remaining <= 1) {
        logger.warn(
          'safetyGuard',
          `Pairing threshold warning: +${cleanPhone} has ${phoneRate.remaining} attempt(s) remaining in ${cfg.pairWindowMinutes}m window.`
        );
      }

      if (targetMode === 'main') {
        await startMainBot({ pairingPhone: cleanPhone });
        for (let i = 0; i < 28; i += 1) {
          const snap = getBotSnapshot();
          if (snap.pairingCode) {
            return res.json({
              ok: true,
              pairingCode: snap.pairingCode,
              phone: cleanPhone,
              tier: auth.vip?.tier || 'vip',
              reason: auth.reason,
              remainingAttempts: phoneRate.remaining,
            });
          }
          if (snap.lastError) {
            return res.status(502).json({ ok: false, error: snap.lastError });
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        return res.status(202).json({
          ok: true,
          pending: true,
          message: 'Socket connecting. Check live status panel for the 8-digit pairing code.',
        });
      }

      const result = await requestVipSubPairingCode(cleanPhone, 'dashboard');
      if (!result.success || !result.code) {
        return res.status(502).json({
          ok: false,
          error: result.error || 'WhatsApp did not return a pairing code.',
        });
      }

      return res.json({
        ok: true,
        pairingCode: result.code,
        sessionId: result.sessionId,
        phone: cleanPhone,
        tier: auth.vip?.tier || 'vip',
        reason: auth.reason,
        remainingAttempts: phoneRate.remaining,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Admin Authentication
  app.post('/api/admin/login', (req, res) => {
    const password = String(req.body?.password || '');
    if (!verifyAdminPassword(password)) {
      logger.security('adminAuth', `Failed admin login attempt from ${req.ip || 'unknown'}`);
      return res.status(401).json({ ok: false, error: 'Incorrect admin password.' });
    }
    const session = createAdminSession();
    logger.info('adminAuth', 'Admin panel unlocked.');
    return res.json({ ok: true, token: session.token, expiresAt: session.expiresAt });
  });

  app.post('/api/admin/logout', (req, res) => {
    revokeAdminToken(extractTokenFromRequest(req));
    res.json({ ok: true });
  });

  app.get('/api/admin/session', (req, res) => {
    const valid = isValidAdminToken(extractTokenFromRequest(req));
    res.json({ authenticated: valid });
  });

  // ============================================================================
  // PROTECTED ADMIN PANEL ENDPOINTS (Require Valid Admin Session Token)
  // ============================================================================

  app.get('/api/bot/status', requireAdmin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const cfg = loadConfig();
    const snapshot = getBotSnapshot();
    const combined = vipStore.getCombinedActiveUsers(snapshot);
    const botOnline =
      snapshot.status === 'connected' ||
      snapshot.subSessions.some((s) => s.status === 'connected');

    res.json({
      bot: snapshot,
      config: {
        botName: cfg.botName,
        ownerNumber: cfg.ownerNumber,
        ownerName: cfg.ownerName,
        prefix: cfg.prefix,
        mode: cfg.mode,
        vipOnlyPairing: cfg.vipOnlyPairing,
        maxPairAttempts: cfg.maxPairAttempts,
        pairWindowMinutes: cfg.pairWindowMinutes,
        pairCooldownSeconds: cfg.pairCooldownSeconds,
        cmdCooldownSeconds: cfg.cmdCooldownSeconds,
        groupCmdCooldownSeconds: cfg.groupCmdCooldownSeconds,
        tagCooldownSeconds: cfg.tagCooldownSeconds,
        tagMaxPerHour: cfg.tagMaxPerHour,
        autoReadMessages: cfg.autoReadMessages,
        autoStatusSeen: cfg.autoStatusSeen,
        autoTyping: cfg.autoTyping,
        autoRecording: cfg.autoRecording,
        broadcastDelayMs: cfg.broadcastDelayMs,
        broadcastDelayMinMs: cfg.broadcastDelayMinMs,
        broadcastDelayMaxMs: cfg.broadcastDelayMaxMs,
        maxBroadcastTargets: cfg.maxBroadcastTargets,
        maxReconnectAttempts: cfg.maxReconnectAttempts,
        humanDelayEnabled: cfg.humanDelayEnabled,
        humanDelayMinMs: cfg.humanDelayMinMs,
        humanDelayMaxMs: cfg.humanDelayMaxMs,
        autoJoinGroupInvite: cfg.autoJoinGroupInvite,
        autoJoinChannelInvite: cfg.autoJoinChannelInvite,
        sendConnectSelfMessage: cfg.sendConnectSelfMessage,
        anticallGlobal: cfg.anticallGlobal,
        antiScamGlobal: cfg.antiScamGlobal,
        antiScamBlockAllStickers: cfg.antiScamBlockAllStickers,
        antiStatusMentionGlobal: cfg.antiStatusMentionGlobal,
        antiVirusGlobal: cfg.antiVirusGlobal,
        autoForwardIbToOpenGcs: cfg.autoForwardIbToOpenGcs,
        autoReact: cfg.autoReact,
        aiEnabled: cfg.aiEnabled,
        singleTick: cfg.singleTick,
        alwaysOnline: cfg.alwaysOnline,
        stickerPack: cfg.stickerPack,
        stickerAuthor: cfg.stickerAuthor,
        menuImageUrl: cfg.menuImageUrl,
        menuChannelJid: cfg.menuChannelJid,
        menuChannelName: cfg.menuChannelName,
        menuChannelUrl: cfg.menuChannelUrl,
      },
      stats: {
        serverOnline: true,
        botOnline,
        activeVips: combined.activeVipsCount,
        activePaidUsersCount: combined.activePaidUsersCount,
        paidUsers: combined.users,
        totalPairings: combined.totalPairings,
        commandCount: getAllCommands().length,
        activeBlocks: pairingRateLimiter.getActiveBlocks().length,
      },
      logs: logger.getRecent(40),
      pairingLogs: vipStore.getPairingLogs(25),
      blockedKeys: pairingRateLimiter.getActiveBlocks(),
    });
  });

  app.post('/api/bot/restart', requireAdmin, async (_req, res) => {
    await restartMainBot();
    res.json({ ok: true, message: 'Bot socket restarted cleanly.' });
  });

  app.post('/api/bot/disconnect', requireAdmin, async (req, res) => {
    const clearSession = Boolean(req.body?.clearSession);
    await disconnectMainBot(clearSession);
    res.json({
      ok: true,
      message: clearSession ? 'Session wiped and disconnected.' : 'Bot disconnected.',
    });
  });

  app.post('/api/bot/reset-ratelimit', requireAdmin, (req, res) => {
    const key = String(req.body?.key || '');
    if (key) pairingRateLimiter.reset(key);
    res.json({ ok: true });
  });

  app.get('/api/config', requireAdmin, (_req, res) => {
    res.json({ ok: true, config: loadConfig() });
  });

  app.patch('/api/config', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const prevCfg = loadConfig();
    let updated = saveConfig({
      botName: typeof body.botName === 'string' ? body.botName : undefined,
      ownerName: typeof body.ownerName === 'string' ? body.ownerName : undefined,
      ownerNumber: typeof body.ownerNumber === 'string' ? body.ownerNumber : undefined,
      prefix: typeof body.prefix === 'string' ? body.prefix : undefined,
      mode: body.mode === 'self' || body.mode === 'public' ? body.mode : undefined,
      vipOnlyPairing:
        typeof body.vipOnlyPairing === 'boolean' ? body.vipOnlyPairing : undefined,
      maxPairAttempts:
        body.maxPairAttempts !== undefined ? Number(body.maxPairAttempts) : undefined,
      pairWindowMinutes:
        body.pairWindowMinutes !== undefined ? Number(body.pairWindowMinutes) : undefined,
      pairCooldownSeconds:
        body.pairCooldownSeconds !== undefined ? Number(body.pairCooldownSeconds) : undefined,
      cmdCooldownSeconds:
        body.cmdCooldownSeconds !== undefined ? Number(body.cmdCooldownSeconds) : undefined,
      groupCmdCooldownSeconds:
        body.groupCmdCooldownSeconds !== undefined ? Number(body.groupCmdCooldownSeconds) : undefined,
      tagCooldownSeconds:
        body.tagCooldownSeconds !== undefined ? Number(body.tagCooldownSeconds) : undefined,
      tagMaxPerHour:
        body.tagMaxPerHour !== undefined ? Number(body.tagMaxPerHour) : undefined,
      autoReadMessages:
        typeof body.autoReadMessages === 'boolean' ? body.autoReadMessages : undefined,
      autoStatusSeen:
        typeof body.autoStatusSeen === 'boolean' ? body.autoStatusSeen : undefined,
      autoTyping:
        typeof body.autoTyping === 'boolean' ? body.autoTyping : undefined,
      autoRecording:
        typeof body.autoRecording === 'boolean' ? body.autoRecording : undefined,
      broadcastDelayMs:
        body.broadcastDelayMs !== undefined ? Number(body.broadcastDelayMs) : undefined,
      broadcastDelayMinMs:
        body.broadcastDelayMinMs !== undefined ? Number(body.broadcastDelayMinMs) : undefined,
      broadcastDelayMaxMs:
        body.broadcastDelayMaxMs !== undefined ? Number(body.broadcastDelayMaxMs) : undefined,
      maxBroadcastTargets:
        body.maxBroadcastTargets !== undefined ? Number(body.maxBroadcastTargets) : undefined,
      maxReconnectAttempts:
        body.maxReconnectAttempts !== undefined ? Number(body.maxReconnectAttempts) : undefined,
      humanDelayEnabled:
        typeof body.humanDelayEnabled === 'boolean' ? body.humanDelayEnabled : undefined,
      humanDelayMinMs:
        body.humanDelayMinMs !== undefined ? Number(body.humanDelayMinMs) : undefined,
      humanDelayMaxMs:
        body.humanDelayMaxMs !== undefined ? Number(body.humanDelayMaxMs) : undefined,
      autoJoinGroupInvite:
        typeof body.autoJoinGroupInvite === 'string' ? body.autoJoinGroupInvite : undefined,
      autoJoinChannelInvite:
        typeof body.autoJoinChannelInvite === 'string' ? body.autoJoinChannelInvite : undefined,
      sendConnectSelfMessage:
        typeof body.sendConnectSelfMessage === 'boolean' ? body.sendConnectSelfMessage : undefined,
      anticallGlobal:
        typeof body.anticallGlobal === 'boolean' ? body.anticallGlobal : undefined,
      antiScamGlobal:
        typeof body.antiScamGlobal === 'boolean' ? body.antiScamGlobal : undefined,
      antiScamBlockAllStickers:
        typeof body.antiScamBlockAllStickers === 'boolean'
          ? body.antiScamBlockAllStickers
          : undefined,
      antiStatusMentionGlobal:
        typeof body.antiStatusMentionGlobal === 'boolean'
          ? body.antiStatusMentionGlobal
          : undefined,
      antiVirusGlobal:
        typeof body.antiVirusGlobal === 'boolean'
          ? body.antiVirusGlobal
          : undefined,
      autoForwardIbToOpenGcs:
        typeof body.autoForwardIbToOpenGcs === 'boolean'
          ? body.autoForwardIbToOpenGcs
          : undefined,
      autoReact: typeof body.autoReact === 'boolean' ? body.autoReact : undefined,
      aiEnabled: typeof body.aiEnabled === 'boolean' ? body.aiEnabled : undefined,
      singleTick: typeof body.singleTick === 'boolean' ? body.singleTick : undefined,
      alwaysOnline: typeof body.alwaysOnline === 'boolean' ? body.alwaysOnline : undefined,
      stickerPack: typeof body.stickerPack === 'string' ? body.stickerPack : undefined,
      stickerAuthor: typeof body.stickerAuthor === 'string' ? body.stickerAuthor : undefined,
      menuImageUrl: typeof body.menuImageUrl === 'string' ? body.menuImageUrl : undefined,
      menuChannelJid: typeof body.menuChannelJid === 'string' ? body.menuChannelJid : undefined,
      menuChannelName: typeof body.menuChannelName === 'string' ? body.menuChannelName : undefined,
      menuChannelUrl: typeof body.menuChannelUrl === 'string' ? body.menuChannelUrl : undefined,
    });

    const explicitJidTyped =
      typeof body.menuChannelJid === 'string' && body.menuChannelJid.trim().includes('@newsletter');
    const urlChanged = updated.menuChannelUrl !== prevCfg.menuChannelUrl;
    const targetChannelSource = updated.menuChannelUrl || updated.autoJoinChannelInvite;
    if (targetChannelSource && (!updated.menuChannelJid || (urlChanged && !explicitJidTyped))) {
      const resolved = await resolveNewsletterMetadataFromActiveSockets(targetChannelSource);
      if (resolved?.jid) {
        const useResolvedName =
          resolved.name &&
          (!body.menuChannelName || updated.menuChannelName === 'FADI KING MD OFFICIAL');
        updated = saveConfig({
          menuChannelJid: resolved.jid,
          menuChannelName: useResolvedName ? resolved.name : updated.menuChannelName,
        });
      }
    }

    if (
      updated.autoJoinGroupInvite !== prevCfg.autoJoinGroupInvite ||
      updated.autoJoinChannelInvite !== prevCfg.autoJoinChannelInvite
    ) {
      void syncAutoJoinsAcrossConnectedSessions();
    }
    if (updated.singleTick !== prevCfg.singleTick) {
      void applySingleTickPresenceAcrossSockets(updated.singleTick);
    }
    if (updated.alwaysOnline !== prevCfg.alwaysOnline) {
      void applyAlwaysOnlinePresenceAcrossSockets(updated.alwaysOnline);
    }
    logger.info('config', `Updated configuration (mode=${updated.mode}, prefix=${updated.prefix})`);
    res.json({ ok: true, config: updated });
  });

  app.get('/api/vips', requireAdmin, (_req, res) => {
    res.json({ ok: true, vips: vipStore.listVips() });
  });

  app.post('/api/vips', requireAdmin, (req, res) => {
    const clean = normalizePhone(String(req.body?.number || ''));
    if (!isValidPhone(clean)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number (8-15 digits required).' });
    }
    const rawTier = String(req.body?.tier || 'gold').toLowerCase();
    const tier: VipTier = rawTier === 'diamond' ? 'diamond' : rawTier === 'owner' ? 'owner' : 'gold';
    const vip = vipStore.addVip({
      number: clean,
      name: String(req.body?.name || '').trim() || undefined,
      tier,
      addedBy: 'admin_panel',
    });
    logger.info('vipStore', `Added VIP +${vip.number} (${vip.tier})`);
    res.json({ ok: true, vip });
  });

  app.delete('/api/vips/:number', requireAdmin, (req, res) => {
    const result = vipStore.removeVip(req.params.number);
    if (!result.removed) {
      return res.status(400).json({ ok: false, error: result.reason });
    }
    logger.info('vipStore', `Removed VIP +${normalizePhone(req.params.number)}`);
    res.json({ ok: true });
  });

  app.get('/api/commands', requireAdmin, (_req, res) => {
    const timings = vipStore.getCommandTimings();
    const commands = getAllCommands().map((c) => {
      const rule = timings[c.name.toLowerCase()];
      return {
        name: c.name,
        aliases: c.aliases || [],
        category: c.category,
        description: c.description,
        usage: c.usage,
        ownerOnly: Boolean(c.ownerOnly),
        vipOnly: Boolean(c.vipOnly),
        groupOnly: Boolean(c.groupOnly),
        cooldownSeconds: Number(c.cooldownSeconds || 0),
        delaySeconds: Math.max(0, Math.min(300, Math.floor(Number(rule?.delaySeconds || 0)))),
        deleteAfterSeconds: Math.max(
          0,
          Math.min(86400, Math.floor(Number(rule?.deleteAfterSeconds || 0)))
        ),
      };
    });
    res.json({ ok: true, commands });
  });

  app.patch('/api/commands/:name/timing', requireAdmin, (req, res) => {
    const cmd = findCommand(String(req.params.name || '').trim().toLowerCase());
    if (!cmd) {
      return res.status(404).json({ ok: false, error: 'Command not found.' });
    }
    const patch: { delaySeconds?: number; deleteAfterSeconds?: number } = {};
    if (req.body?.delaySeconds !== undefined) {
      const n = Number(req.body.delaySeconds);
      if (Number.isFinite(n)) patch.delaySeconds = n;
    }
    if (req.body?.deleteAfterSeconds !== undefined) {
      const n = Number(req.body.deleteAfterSeconds);
      if (Number.isFinite(n)) patch.deleteAfterSeconds = n;
    }
    const timing = vipStore.setCommandTiming(cmd.name, patch);
    logger.info(
      'commands',
      `Updated timing for .${cmd.name}: delay=${timing.delaySeconds}s, auto-delete=${timing.deleteAfterSeconds}s`
    );
    return res.json({ ok: true, name: cmd.name, timing });
  });

  app.post('/api/commands/timing/bulk', requireAdmin, (req, res) => {
    const allNames = getAllCommands().map((c) => c.name.toLowerCase());
    const allowedSet = new Set(allNames);
    const requestedNames = Array.isArray(req.body?.names)
      ? req.body.names
          .map((n: unknown) => String(n || '').trim().toLowerCase())
          .filter((n: string) => allowedSet.has(n))
      : allNames;

    const patch: { delaySeconds?: number; deleteAfterSeconds?: number } = {};
    if (req.body?.delaySeconds !== undefined) {
      const n = Number(req.body.delaySeconds);
      if (Number.isFinite(n)) patch.delaySeconds = n;
    }
    if (req.body?.deleteAfterSeconds !== undefined) {
      const n = Number(req.body.deleteAfterSeconds);
      if (Number.isFinite(n)) patch.deleteAfterSeconds = n;
    }

    const timings = vipStore.setBulkCommandTimings(requestedNames, patch);
    logger.info(
      'commands',
      `Bulk updated timing for ${requestedNames.length} command(s): delay=${patch.delaySeconds ?? 'unchanged'}s, auto-delete=${patch.deleteAfterSeconds ?? 'unchanged'}s`
    );
    return res.json({ ok: true, count: requestedNames.length, timings });
  });

  app.post('/api/commands/execute', requireAdmin, async (req, res) => {
    const input = String(req.body?.input || '');
    const senderNumber = typeof req.body?.senderNumber === 'string' ? req.body.senderNumber : undefined;
    const result = await executeConsoleCommand(input, senderNumber);
    res.json(result);
  });

  app.get('/api/groups', requireAdmin, (_req, res) => {
    res.json({ ok: true, groups: vipStore.listGroupConfigs() });
  });

  app.patch('/api/groups/:groupId', requireAdmin, (req, res) => {
    const rawMode = req.body?.antilinkMode;
    const antilinkMode =
      rawMode === 'off' || rawMode === 'delete' || rawMode === 'warn' || rawMode === 'kick'
        ? rawMode
        : undefined;
    const updated = vipStore.updateGroupConfig(req.params.groupId, {
      antilink:
        antilinkMode !== undefined
          ? antilinkMode !== 'off'
          : typeof req.body?.antilink === 'boolean'
            ? req.body.antilink
            : undefined,
      antilinkMode,
      antiScam: typeof req.body?.antiScam === 'boolean' ? req.body.antiScam : undefined,
      antiStatusMention:
        typeof req.body?.antiStatusMention === 'boolean' ? req.body.antiStatusMention : undefined,
      antiVirus: typeof req.body?.antiVirus === 'boolean' ? req.body.antiVirus : undefined,
      aiEnabled: typeof req.body?.aiEnabled === 'boolean' ? req.body.aiEnabled : undefined,
      antiAdd: typeof req.body?.antiAdd === 'boolean' ? req.body.antiAdd : undefined,
      antiForward: typeof req.body?.antiForward === 'boolean' ? req.body.antiForward : undefined,
      antiMedia: typeof req.body?.antiMedia === 'boolean' ? req.body.antiMedia : undefined,
      antiSticker: typeof req.body?.antiSticker === 'boolean' ? req.body.antiSticker : undefined,
      antiBot: typeof req.body?.antiBot === 'boolean' ? req.body.antiBot : undefined,
      antiPayMsg: typeof req.body?.antiPayMsg === 'boolean' ? req.body.antiPayMsg : undefined,
      slowModeSeconds:
        typeof req.body?.slowModeSeconds === 'number' && Number.isFinite(req.body.slowModeSeconds)
          ? Math.max(0, Math.min(3600, Math.round(req.body.slowModeSeconds)))
          : undefined,
      welcome: typeof req.body?.welcome === 'boolean' ? req.body.welcome : undefined,
      goodbye: typeof req.body?.goodbye === 'boolean' ? req.body.goodbye : undefined,
    });
    res.json({ ok: true, group: updated });
  });

  // Anti-Virus & Zero-Day Crash Shield Registry (Admin Only)
  app.get('/api/antivirus', requireAdmin, (_req, res) => {
    const cfg = loadConfig();
    res.json({
      ok: true,
      globalEnabled: cfg.antiVirusGlobal,
      blacklist: crashGuardStore.listBlacklist(),
      incidents: crashGuardStore.listIncidents(25),
    });
  });

  app.delete('/api/antivirus/:target', requireAdmin, (req, res) => {
    const raw = decodeURIComponent(req.params.target || '');
    const clean = normalizePhone(raw);
    const candidates = [raw, clean, clean ? `${clean}@s.whatsapp.net` : ''].filter(Boolean);
    const removed = crashGuardStore.removeFromBlacklist(candidates);
    vipStore.unbanUser(candidates);
    anticallStore.unblockCaller(candidates);
    if (removed) {
      logger.info('crashGuard', `Removed ${raw} from Anti-Virus blacklist via Admin Panel`);
    }
    return res.json({ ok: true, removed });
  });

  // Anti-Call Guard Management (Admin Only)
  app.get('/api/anticall', requireAdmin, (_req, res) => {
    const cfg = loadConfig();
    res.json({
      ok: true,
      globalEnabled: cfg.anticallGlobal,
      blocked: anticallStore.listBlocked(),
    });
  });

  app.post('/api/anticall', requireAdmin, (req, res) => {
    const clean = normalizePhone(String(req.body?.phone || ''));
    if (!isValidPhone(clean)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid phone number (8-15 digits).' });
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : undefined;
    const entry = anticallStore.blockCaller(`${clean}@s.whatsapp.net`, clean, label);
    logger.security('anticall', `Added +${clean} to Anti-Call guard via Admin Panel`);
    return res.json({ ok: true, entry });
  });

  app.delete('/api/anticall/:target', requireAdmin, (req, res) => {
    const raw = decodeURIComponent(req.params.target || '');
    const clean = normalizePhone(raw);
    const removed = anticallStore.unblockCaller([raw, clean, `${clean}@s.whatsapp.net`]);
    if (removed) {
      logger.info('anticall', `Removed ${raw} from Anti-Call guard via Admin Panel`);
    }
    return res.json({ ok: true, removed });
  });

  // Ban & Unban Multi-Report Templates, Settings & Execution History (Admin Only)
  app.get('/api/reports', requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      templates: reportStore.listTemplates(),
      settings: reportStore.getPublicSettings(),
      logs: reportStore.listLogs(50),
    });
  });

  app.post('/api/reports/templates', requireAdmin, (req, res) => {
    const rawType = String(req.body?.type || '').toLowerCase();
    const type: ReportActionType = rawType === 'unban' ? 'unban' : 'ban';
    const rawBlock = typeof req.body?.rawBlock === 'string' ? req.body.rawBlock.trim() : '';

    if (rawBlock) {
      const created = reportStore.bulkAddTemplates({ type, rawBlock });
      if (created.length === 0) {
        return res.status(400).json({ ok: false, error: 'Paste at least one report text.' });
      }
      logger.info('reportEngine', `Added ${created.length} ${type} report template(s) via Admin Panel`);
      return res.json({ ok: true, created });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ ok: false, error: 'Report text cannot be empty.' });
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
    const entry = reportStore.addTemplate({ type, title, body });
    logger.info('reportEngine', `Added ${type} report template "${entry.title}"`);
    return res.json({ ok: true, template: entry });
  });

  app.patch('/api/reports/templates/:id', requireAdmin, (req, res) => {
    const updated = reportStore.updateTemplate(req.params.id, {
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    });
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Report template not found.' });
    }
    return res.json({ ok: true, template: updated });
  });

  app.delete('/api/reports/templates/type/:type', requireAdmin, (req, res) => {
    const type: ReportActionType = req.params.type === 'unban' ? 'unban' : 'ban';
    const removed = reportStore.clearTemplates(type);
    return res.json({ ok: true, removed });
  });

  app.delete('/api/reports/templates/:id', requireAdmin, (req, res) => {
    const deleted = reportStore.deleteTemplate(req.params.id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Report template not found.' });
    }
    return res.json({ ok: true });
  });

  app.patch('/api/reports/settings', requireAdmin, (req, res) => {
    const b = req.body || {};
    reportStore.updateSettings({
      banRepeatCount: typeof b.banRepeatCount === 'number' ? b.banRepeatCount : undefined,
      unbanRepeatCount: typeof b.unbanRepeatCount === 'number' ? b.unbanRepeatCount : undefined,
      blockOnBan: typeof b.blockOnBan === 'boolean' ? b.blockOnBan : undefined,
      unblockOnUnban: typeof b.unblockOnUnban === 'boolean' ? b.unblockOnUnban : undefined,
      sendSpamStanzaOnBan:
        typeof b.sendSpamStanzaOnBan === 'boolean' ? b.sendSpamStanzaOnBan : undefined,
      echoReportsInChat:
        typeof b.echoReportsInChat === 'boolean' ? b.echoReportsInChat : undefined,
      smtpEnabled: typeof b.smtpEnabled === 'boolean' ? b.smtpEnabled : undefined,
      smtpHost: typeof b.smtpHost === 'string' ? b.smtpHost : undefined,
      smtpPort: typeof b.smtpPort === 'number' ? b.smtpPort : undefined,
      smtpSecure: typeof b.smtpSecure === 'boolean' ? b.smtpSecure : undefined,
      smtpUser: typeof b.smtpUser === 'string' ? b.smtpUser : undefined,
      smtpPass: typeof b.smtpPass === 'string' ? b.smtpPass : undefined,
      supportRecipients:
        typeof b.supportRecipients === 'string' ? b.supportRecipients : undefined,
    });
    return res.json({ ok: true, settings: reportStore.getPublicSettings() });
  });

  app.post('/api/reports/test-smtp', requireAdmin, async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : undefined;
    const result = await sendTestSmtpEmail(to);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/reports/run', requireAdmin, async (req, res) => {
    const type: ReportActionType = req.body?.type === 'unban' ? 'unban' : 'ban';
    const clean = normalizePhone(String(req.body?.number || ''));
    if (!isValidPhone(clean)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid phone number (8-15 digits).' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
    const targetJid = `${clean}@s.whatsapp.net`;

    if (type === 'ban') {
      const cfg = loadConfig();
      if (clean === normalizePhone(cfg.ownerNumber) || vipStore.isOwner(clean)) {
        return res.status(400).json({ ok: false, error: 'Cannot ban or report the Bot Owner.' });
      }
      vipStore.banUser({
        number: clean,
        jid: targetJid,
        reason,
        bannedBy: 'admin_panel',
      });
    } else {
      vipStore.unbanUser([clean, targetJid]);
    }

    const activeSock = getPreferredActiveSocket();
    const log = await executeMultiReport({
      sock: activeSock,
      type,
      targetNumber: clean,
      targetJid,
      reason,
      triggeredBy: 'admin_panel',
      isSimulated: !activeSock,
    });

    return res.json({ ok: true, log });
  });

  app.delete('/api/reports/logs', requireAdmin, (_req, res) => {
    reportStore.clearLogs();
    return res.json({ ok: true });
  });

  app.post('/api/broadcast', requireAdmin, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ ok: false, message: 'Broadcast text is required.' });
    }
    const result = await sendDashboardBroadcast(text);
    res.json(result);
  });

  // Portal Header Banner & Live Screen & Bell Alerts Admin Controls
  app.put('/api/admin/portal-banner', requireAdmin, (req, res) => {
    const body = req.body || {};
    const updated = liveStore.updatePortalBanner({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      mediaType:
        body.mediaType === 'image' || body.mediaType === 'video' || body.mediaType === 'none'
          ? body.mediaType
          : undefined,
      mediaUrl: typeof body.mediaUrl === 'string' ? body.mediaUrl : undefined,
      caption: typeof body.caption === 'string' ? body.caption : undefined,
    });
    logger.info('portalBanner', `Updated top portal banner (enabled=${updated.enabled}, media=${updated.mediaType})`);
    res.json({ ok: true, portalBanner: updated });
  });

  app.put('/api/admin/live-screen', requireAdmin, (req, res) => {
    const body = req.body || {};
    const updated = liveStore.updateLiveScreen({
      active: typeof body.active === 'boolean' ? body.active : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      mediaType:
        body.mediaType === 'image' || body.mediaType === 'video' || body.mediaType === 'none'
          ? body.mediaType
          : undefined,
      mediaUrl: typeof body.mediaUrl === 'string' ? body.mediaUrl : undefined,
    });
    logger.info('liveScreen', `Updated public Live Screen (active=${updated.active}, media=${updated.mediaType})`);
    res.json({ ok: true, liveScreen: updated });
  });

  app.post('/api/admin/upload-media', requireAdmin, (req, res) => {
    try {
      const dataUrl = String(req.body?.dataUrl || '');
      const mimeType = String(req.body?.mimeType || '');
      if (!dataUrl || !mimeType) {
        return res.status(400).json({ ok: false, error: 'File dataUrl and mimeType required.' });
      }
      const saved = liveStore.saveUploadedMedia(dataUrl, mimeType);
      logger.info('liveScreen', `Uploaded live media asset ${saved.filename}`);
      return res.json({ ok: true, url: saved.url, filename: saved.filename });
    } catch (err) {
      return res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/admin/alerts', requireAdmin, (req, res) => {
    const title = String(req.body?.title || '').trim();
    const message = String(req.body?.message || '').trim();
    const level = String(req.body?.level || 'info') as AlertLevel;
    if (!message) {
      return res.status(400).json({ ok: false, error: 'Alert message is required.' });
    }
    const alert = liveStore.addAlert({
      title: title || 'Admin Announcement',
      message,
      level,
    });
    logger.info('alerts', `Dispatched public bell notification: "${alert.title}"`);
    return res.json({ ok: true, alert });
  });

  app.delete('/api/admin/alerts/:id', requireAdmin, (req, res) => {
    liveStore.deleteAlert(req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/admin/alerts', requireAdmin, (_req, res) => {
    liveStore.clearAlerts();
    res.json({ ok: true });
  });

  // Source Code Inspector & Complete ZIP Export (Admin Only)
  app.get('/api/source/files', requireAdmin, (_req, res) => {
    const root = process.cwd();
    const files = SOURCE_FILES.filter((rel) => fs.existsSync(path.join(root, rel))).map((rel) => ({
      path: rel,
      content: fs.readFileSync(path.join(root, rel), 'utf-8'),
    }));
    res.json({ ok: true, files });
  });

  app.get('/api/source/download', requireAdmin, async (_req, res) => {
    try {
      const zip = new JSZip();
      const root = process.cwd();
      for (const rel of SOURCE_FILES) {
        const full = path.join(root, rel);
        if (fs.existsSync(full)) {
          zip.file(rel, fs.readFileSync(full, 'utf-8'));
        }
      }
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="fadi-king-md-bot.zip"');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Mount Vite in dev or serve built static files in production
  if (isDev) {
    app.use((req, res, next) => {
      if (viteMiddleware) {
        return viteMiddleware(req, res, next);
      }
      return next();
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  let bindRetries = 0;
  const httpServer = app.listen(port, '0.0.0.0', () => {
    logger.info('server', `FADI KING MD Control Board running on http://0.0.0.0:${port}`);
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && bindRetries < 5) {
      bindRetries += 1;
      logger.warn('server', `Port ${port} busy, retrying bind (${bindRetries}/5)...`);
      setTimeout(() => {
        httpServer.listen(port, '0.0.0.0');
      }, 350);
      return;
    }
    logger.error('server', `HTTP server failed to bind port ${port}: ${err.message}`);
    process.exit(1);
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.maxRequestsPerSocket = 0;

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server', `Received ${signal}. Closing WhatsApp sockets cleanly before exit...`);
    try {
      closeAllSocketsGracefully();
    } catch {
      // Ignore socket close error on shutdown
    }
    void viteInstance?.close().catch(() => {});
    httpServer.closeAllConnections?.();
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 400).unref();
  };

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

void startServer();
