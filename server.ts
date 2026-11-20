import fs from 'fs';
import path from 'path';
import express from 'express';
import JSZip from 'jszip';
import { isValidPhone, loadConfig, normalizePhone, saveConfig } from './config/bot.config.ts';
import { getAllCommands } from './commands/index.ts';
import {
  disconnectMainBot,
  getBotSnapshot,
  initializeSavedSessionOnBoot,
  requestVipSubPairingCode,
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
import { logger } from './utils/logger.ts';
import { pairingRateLimiter } from './utils/rateLimiter.ts';
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
  'utils/logger.ts',
  'utils/jidHelper.ts',
  'utils/adminAuth.ts',
  'utils/liveStore.ts',
  'utils/anticallStore.ts',
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

  app.get('/api/public/state', (_req, res) => {
    const cfg = loadConfig();
    const snap = getBotSnapshot();
    const connectedSub = snap.subSessions.find((s) => s.status === 'connected');
    const effectiveStatus =
      snap.status === 'connected'
        ? 'connected'
        : connectedSub
          ? 'connected'
          : snap.status;
    const effectivePhone = snap.connectedUser?.phone || connectedSub?.connectedUser?.phone || connectedSub?.phone || null;

    res.json({
      bot: {
        status: effectiveStatus,
        qrDataUrl: snap.qrDataUrl,
        pairingCode: snap.pairingCode,
        pairingPhone: snap.pairingPhone,
        connectedPhone: effectivePhone,
        lastError: snap.lastError,
        uptimeSeconds: snap.uptimeSeconds,
        vipOnlyPairing: cfg.vipOnlyPairing,
        pairCooldownSeconds: cfg.pairCooldownSeconds,
        maxPairAttempts: cfg.maxPairAttempts,
        pairWindowMinutes: cfg.pairWindowMinutes,
        prefix: cfg.prefix,
        botName: cfg.botName,
        activeSessions: snap.subSessions.map((s) => ({
          phone: s.phone,
          status: s.status,
        })),
      },
      liveScreen: liveStore.getLiveScreen(),
      alerts: liveStore.getAlerts(25),
    });
  });

  app.get('/api/public/media/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename || '');
    if (!safeName || safeName.includes('..')) {
      return res.status(400).end();
    }
    const fullPath = path.join(liveStore.getMediaDir(), safeName);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).end();
    }
    return res.sendFile(fullPath);
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
    const cfg = loadConfig();
    const snapshot = getBotSnapshot();
    const vips = vipStore.listVips();
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
        stickerPack: cfg.stickerPack,
        stickerAuthor: cfg.stickerAuthor,
      },
      stats: {
        activeVips: vips.filter((v) => v.active).length,
        totalPairings: vips.reduce((sum, v) => sum + v.pairingCount, 0),
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

  app.patch('/api/config', requireAdmin, (req, res) => {
    const body = req.body || {};
    const prevCfg = loadConfig();
    const updated = saveConfig({
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
      stickerPack: typeof body.stickerPack === 'string' ? body.stickerPack : undefined,
      stickerAuthor: typeof body.stickerAuthor === 'string' ? body.stickerAuthor : undefined,
    });
    if (
      updated.autoJoinGroupInvite !== prevCfg.autoJoinGroupInvite ||
      updated.autoJoinChannelInvite !== prevCfg.autoJoinChannelInvite
    ) {
      void syncAutoJoinsAcrossConnectedSessions();
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
    const commands = getAllCommands().map((c) => ({
      name: c.name,
      aliases: c.aliases || [],
      category: c.category,
      description: c.description,
      usage: c.usage,
      ownerOnly: Boolean(c.ownerOnly),
      vipOnly: Boolean(c.vipOnly),
      groupOnly: Boolean(c.groupOnly),
    }));
    res.json({ ok: true, commands });
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
      welcome: typeof req.body?.welcome === 'boolean' ? req.body.welcome : undefined,
      goodbye: typeof req.body?.goodbye === 'boolean' ? req.body.goodbye : undefined,
    });
    res.json({ ok: true, group: updated });
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

  app.post('/api/broadcast', requireAdmin, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ ok: false, message: 'Broadcast text is required.' });
    }
    const result = await sendDashboardBroadcast(text);
    res.json(result);
  });

  // Live Screen & Bell Alerts Admin Controls
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
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = app.listen(port, '0.0.0.0', () => {
    logger.info('server', `FADI KING MD Control Board running on http://0.0.0.0:${port}`);
    initializeSavedSessionOnBoot();
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.maxRequestsPerSocket = 0;
}

void startServer();
