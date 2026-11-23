import fs from 'fs';
import path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type CacheStore,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import { anticallStore } from '../utils/anticallStore.ts';
import {
  backupAuthDirToDb,
  deleteAuthBackupFromDb,
  restoreAuthDirsFromDb,
} from '../utils/db.ts';
import {
  extractChannelTargets,
  extractGroupInviteCodes,
  getGroupMetadataFromCacheOnly,
  hasValidMediaPayload,
  invalidateGroupMetadataCache,
  isLidUser,
  jidUserPart,
  normalizeBareJid,
  rememberUserName,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import {
  precacheViewOnceMedia,
  recordUnavailableViewOnceKey,
  registerSocketPlaceholderCache,
  sanitizeMessageKeyForPdo,
} from '../utils/mediaHelper.ts';
import { getRandomDelayMs } from '../utils/rateLimiter.ts';
import { startReminderScheduler } from '../utils/reminderStore.ts';
import { recordBroadcastStatus } from '../utils/statusStore.ts';
import { vipStore } from '../utils/vipStore.ts';
import { handleGroupParticipantsUpdate } from './group.ts';
import { handleIncomingMessage } from './message.ts';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'qr_ready'
  | 'pairing_ready'
  | 'connected'
  | 'logged_out'
  | 'disconnected';

export interface ActiveSessionInfo {
  sessionId: string;
  phone: string;
  status: ConnectionStatus;
  connectedUser?: { id: string; name: string; phone: string };
  lastPairingCode?: string;
  createdAt: string;
}

interface MainBotState {
  status: ConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  connectedUser: { id: string; name: string; phone: string } | null;
  lastError: string | null;
  reconnectAttempts: number;
  startedAt: number;
}

const silentPino = pino({ level: 'silent' });
let mainSock: WASocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
const vipSubSockets = new Map<string, { sock: WASocket; info: ActiveSessionInfo }>();
const vipReconnectTimers = new Map<string, NodeJS.Timeout>();
const messageCache = new Map<string, WAMessage>();
const messageByIdCache = new Map<string, WAMessage>();
const persistedSessionsCache = new Set<string>();
const pendingFreshPairs = new Set<string>();
const authBackupTimers = new Map<string, NodeJS.Timeout>();
let mainHasSavedCredsCache = false;
let persistedCacheLoaded = false;

function scheduleAuthBackup(sessionKey: string, authDir: string, delayMs = 2500): void {
  const existing = authBackupTimers.get(sessionKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    authBackupTimers.delete(sessionKey);
    if (hasSavedAuth(authDir)) {
      void backupAuthDirToDb(sessionKey, authDir);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  authBackupTimers.set(sessionKey, timer);
}

function isSocketWsDead(sock: WASocket | null | undefined): boolean {
  if (!sock) return true;
  const ws = (sock as unknown as { ws?: { isClosed?: boolean; isClosing?: boolean; readyState?: number } }).ws;
  if (!ws) return false;
  if (ws.isClosed || ws.isClosing) return true;
  if (typeof ws.readyState === 'number' && ws.readyState > 1) return true;
  return false;
}

function createBoundedCacheStore(maxEntries = 3000, ttlMs = 10 * 60_000): CacheStore {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    get<T>(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value as T;
    },
    set<T>(key: string, value: T): void {
      const now = Date.now();
      store.set(key, { value, expiresAt: now + ttlMs });
      if (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest) store.delete(oldest);
      }
    },
    del(key: string): void {
      store.delete(key);
    },
    flushAll(): void {
      store.clear();
    },
  };
}

// Shared bounded cache across sockets avoids spawning hundreds of NodeCache timers
const sharedMsgRetryCache = createBoundedCacheStore(4000, 5 * 60_000);
const sharedPlaceholderResendCache = createBoundedCacheStore(2000, 45_000);

function cacheMessage(msg: WAMessage): void {
  const jid = msg.key?.remoteJid;
  const id = msg.key?.id;
  if (!jid || !id || !msg.message) return;
  const bareJid = normalizeBareJid(jid);
  const cacheKey = `${bareJid}:${id}`;

  // Never overwrite an intact cached media message (e.g. unopened View-Once) with a stripped/opened update
  const existing = messageCache.get(cacheKey) || messageByIdCache.get(id);
  if (existing?.message) {
    const existingHasMedia = hasValidMediaPayload(unwrapMessage(existing.message) || existing.message);
    const nextHasMedia = hasValidMediaPayload(unwrapMessage(msg.message) || msg.message);
    if (existingHasMedia && !nextHasMedia) {
      return;
    }
  }

  messageCache.set(cacheKey, msg);
  messageByIdCache.set(id, msg);
  if (messageCache.size > 4000) {
    const oldest = messageCache.keys().next().value;
    if (oldest) messageCache.delete(oldest);
  }
  if (messageByIdCache.size > 4000) {
    const oldestId = messageByIdCache.keys().next().value;
    if (oldestId) messageByIdCache.delete(oldestId);
  }
}

function getCachedMessage(chatId: string, msgId: string): WAMessage | undefined {
  const bareChat = normalizeBareJid(chatId);
  return (
    messageCache.get(`${bareChat}:${msgId}`) ||
    messageCache.get(`${chatId}:${msgId}`) ||
    messageByIdCache.get(msgId)
  );
}

async function getBaileysMessage(key: WAMessageKey) {
  if (!key.id) return undefined;
  return getCachedMessage(key.remoteJid || '', key.id)?.message || undefined;
}

// Cache WA Web version in memory so pairing doesn't block on network fetch every request
let cachedWaVersion: [number, number, number] | undefined;
let waVersionFetchedAt = 0;

async function getFastWaVersion(): Promise<[number, number, number] | undefined> {
  const now = Date.now();
  if (cachedWaVersion && now - waVersionFetchedAt < 6 * 60 * 60 * 1000) {
    return cachedWaVersion;
  }
  try {
    const res = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1800)),
    ]);
    if (res && Array.isArray(res.version)) {
      cachedWaVersion = res.version;
      waVersionFetchedAt = now;
      return cachedWaVersion;
    }
  } catch {
    // Fallback to Baileys bundled WA version
  }
  return cachedWaVersion;
}

const botState: MainBotState = {
  status: 'idle',
  qrDataUrl: null,
  pairingCode: null,
  pairingPhone: null,
  connectedUser: null,
  lastError: null,
  reconnectAttempts: 0,
  startedAt: Date.now(),
};

function formatPairingCode(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
  }
  return clean;
}

function hasSavedAuth(authDir: string): boolean {
  const credsPath = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8')) as { registered?: boolean };
    return Boolean(creds.registered);
  } catch {
    return false;
  }
}

async function hasSavedAuthAsync(authDir: string): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(path.join(authDir, 'creds.json'), 'utf-8');
    const creds = JSON.parse(raw) as { registered?: boolean };
    return Boolean(creds.registered);
  } catch {
    return false;
  }
}

function isTerminalDisconnect(statusCode: number | undefined): boolean {
  return (
    statusCode === DisconnectReason.loggedOut ||
    statusCode === DisconnectReason.badSession ||
    statusCode === DisconnectReason.connectionReplaced ||
    statusCode === DisconnectReason.multideviceMismatch ||
    statusCode === 401 ||
    statusCode === 403
  );
}

const lastConnectNoticeAt = new Map<string, number>();
const lastCallNoticeAt = new Map<string, number>();

interface AutoJoinMarkerState {
  groupCodes: string[];
  channelKeys: string[];
}

async function readAutoJoinMarker(markerPath: string): Promise<AutoJoinMarkerState> {
  try {
    const raw = await fs.promises.readFile(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AutoJoinMarkerState>;
    return {
      groupCodes: Array.isArray(parsed.groupCodes) ? parsed.groupCodes : [],
      channelKeys: Array.isArray(parsed.channelKeys) ? parsed.channelKeys : [],
    };
  } catch {
    return { groupCodes: [], channelKeys: [] };
  }
}

export async function runAutoJoinForSocket(params: {
  sock: WASocket;
  sessionKey: string;
  authDir: string;
  forceCheck?: boolean;
}): Promise<{ groupsJoined: number; channelsFollowed: number }> {
  const { sock, sessionKey, authDir, forceCheck = false } = params;
  const cfg = loadConfig();
  const groupCodes = extractGroupInviteCodes(cfg.autoJoinGroupInvite);
  const channelTargets = extractChannelTargets(cfg.autoJoinChannelInvite);
  if (groupCodes.length === 0 && channelTargets.length === 0) {
    return { groupsJoined: 0, channelsFollowed: 0 };
  }

  const markerPath = path.join(authDir, '.autojoined.json');
  const legacyMarkerPath = path.join(authDir, '.autojoined');
  const state = await readAutoJoinMarker(markerPath);
  if (state.groupCodes.length === 0 && fs.existsSync(legacyMarkerPath)) {
    try {
      const oldCode = (await fs.promises.readFile(legacyMarkerPath, 'utf-8')).trim();
      if (oldCode) state.groupCodes.push(oldCode);
    } catch {
      // Ignore legacy marker
    }
  }

  let groupsJoined = 0;
  let channelsFollowed = 0;
  let dirty = false;

  for (const code of groupCodes) {
    if (!forceCheck && state.groupCodes.includes(code)) continue;
    try {
      await sock.groupAcceptInvite(code);
      if (!state.groupCodes.includes(code)) state.groupCodes.push(code);
      groupsJoined += 1;
      dirty = true;
      logger.info('connection', `Session ${sessionKey} auto-joined group invite (${code}).`);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/already|409|conflict/i.test(msg)) {
        if (!state.groupCodes.includes(code)) {
          state.groupCodes.push(code);
          dirty = true;
        }
        logger.info('connection', `Session ${sessionKey} already in configured group (${code}).`);
      } else {
        logger.warn('connection', `Auto-join group skipped for ${sessionKey} (${code}): ${msg}`);
      }
    }
  }

  for (const target of channelTargets) {
    const markerKey = `${target.type}:${target.value}`;
    if (!forceCheck && state.channelKeys.includes(markerKey)) continue;
    try {
      let newsletterJid = target.type === 'jid' ? target.value : '';
      if (target.type === 'invite' && typeof sock.newsletterMetadata === 'function') {
        const meta = await sock.newsletterMetadata('invite', target.value);
        newsletterJid = meta?.id || '';
      }
      if (newsletterJid && typeof sock.newsletterFollow === 'function') {
        await sock.newsletterFollow(newsletterJid);
        if (!state.channelKeys.includes(markerKey)) {
          state.channelKeys.push(markerKey);
          dirty = true;
        }
        channelsFollowed += 1;
        logger.info('connection', `Session ${sessionKey} auto-followed channel (${target.value}).`);
      } else {
        logger.warn('connection', `Channel follow skipped for ${sessionKey}: newsletter JID unavailable.`);
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/already|409|conflict/i.test(msg)) {
        if (!state.channelKeys.includes(markerKey)) {
          state.channelKeys.push(markerKey);
          dirty = true;
        }
      } else {
        logger.warn('connection', `Auto-follow channel skipped for ${sessionKey} (${target.value}): ${msg}`);
      }
    }
  }

  if (dirty) {
    await fs.promises.mkdir(authDir, { recursive: true }).catch(() => {});
    await fs.promises.writeFile(markerPath, JSON.stringify(state, null, 2), 'utf-8').catch(() => {});
  }

  return { groupsJoined, channelsFollowed };
}

export async function syncAutoJoinsAcrossConnectedSessions(): Promise<void> {
  const cfg = loadConfig();
  const tasks: Array<() => Promise<unknown>> = [];
  if (mainSock && botState.status === 'connected') {
    const s = mainSock;
    tasks.push(() =>
      runAutoJoinForSocket({
        sock: s,
        sessionKey: 'main',
        authDir: path.join(cfg.sessionDir, 'main'),
      })
    );
  }
  for (const [sessionId, entry] of vipSubSockets.entries()) {
    if (entry.info.status === 'connected') {
      const s = entry.sock;
      tasks.push(() =>
        runAutoJoinForSocket({
          sock: s,
          sessionKey: sessionId,
          authDir: path.join(cfg.sessionDir, sessionId),
        })
      );
    }
  }
  for (let i = 0; i < tasks.length; i += 1) {
    await tasks[i]().catch(() => {});
    if (i < tasks.length - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function applySingleTickPresenceAcrossSockets(singleTick: boolean): Promise<void> {
  const cfg = loadConfig();
  const presence = singleTick ? 'unavailable' : 'available';
  if (mainSock && botState.status === 'connected') {
    await mainSock.sendPresenceUpdate(presence).catch(() => {});
  }
  for (const entry of vipSubSockets.values()) {
    if (entry.info.status === 'connected') {
      await entry.sock.sendPresenceUpdate(presence).catch(() => {});
    }
  }
  if (!singleTick && cfg.alwaysOnline) {
    await applyAlwaysOnlinePresenceAcrossSockets(true);
  }
}

export async function applyAlwaysOnlinePresenceAcrossSockets(enabled: boolean): Promise<void> {
  const cfg = loadConfig();
  if (cfg.singleTick) return;
  const presence = enabled ? 'available' : 'unavailable';
  if (mainSock && botState.status === 'connected') {
    await mainSock.sendPresenceUpdate(presence).catch(() => {});
  }
  for (const entry of vipSubSockets.values()) {
    if (entry.info.status === 'connected') {
      await entry.sock.sendPresenceUpdate(presence).catch(() => {});
    }
  }
}

function handleSessionOpenActions(params: {
  sock: WASocket;
  sessionKey: string;
  phone: string;
  authDir: string;
  isFreshPair: boolean;
}): void {
  const { sock, sessionKey, phone, authDir, isFreshPair } = params;
  const cfg = loadConfig();
  const targetJid = phone ? `${phone}@s.whatsapp.net` : sock.user?.id || '';
  const wasPendingFreshPair = pendingFreshPairs.delete(sessionKey);
  const effectiveFreshPair = isFreshPair || wasPendingFreshPair;

  persistedSessionsCache.add(sessionKey);
  if (sessionKey === 'main') mainHasSavedCredsCache = true;
  scheduleAuthBackup(sessionKey, authDir, 800);

  if (phone) {
    vipStore.recordConnectedSession({
      number: phone,
      name: sock.user?.name || (sessionKey === 'main' ? cfg.botName : `+${phone}`),
      sessionId: sessionKey,
      incrementCount: effectiveFreshPair,
      status: 'connected',
    });
  }

  if (cfg.singleTick) {
    void sock.sendPresenceUpdate('unavailable').catch(() => {});
  } else if (cfg.alwaysOnline) {
    void sock.sendPresenceUpdate('available').catch(() => {});
  }

  // 1. Send connection confirmation message into bot's own IB/DM
  if (cfg.sendConnectSelfMessage && targetJid) {
    const now = Date.now();
    const prevAt = lastConnectNoticeAt.get(sessionKey) || 0;
    if (effectiveFreshPair || now - prevAt > 5 * 60_000) {
      lastConnectNoticeAt.set(sessionKey, now);
      const t = setTimeout(() => {
        void sock
          .sendMessage(targetJid, {
            text: [
              `*${cfg.botName} Connected!*`,
              `Your WhatsApp Multi-Device bot (+${phone}) is online and ready.`,
              `Type *${cfg.prefix}menu* to view all commands.`,
            ].join('\n'),
          })
          .catch(() => {});
      }, 650);
      if (typeof t.unref === 'function') t.unref();
    }
  }

  // 2. Automatically join configured WhatsApp Group(s) & Channel(s) upon pairing
  const joinTimer = setTimeout(() => {
    void runAutoJoinForSocket({
      sock,
      sessionKey,
      authDir,
      forceCheck: effectiveFreshPair,
    });
  }, 1100);
  if (typeof joinTimer.unref === 'function') joinTimer.unref();
}

async function handleIncomingCalls(
  sock: WASocket,
  calls: Array<{ id: string; from: string; status: string; isVideo?: boolean; isGroup?: boolean }>
): Promise<void> {
  const cfg = loadConfig();
  for (const call of calls) {
    if (call.status !== 'offer' || !call.from || !call.id) continue;
    const bareFrom = normalizeBareJid(call.from);
    const candidates = [bareFrom];
    if (isLidUser(bareFrom) && sock.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(bareFrom);
        if (pn) candidates.push(normalizeBareJid(pn));
      } catch {
        // Ignore missing LID mapping
      }
    }

    const decision = anticallStore.shouldRejectCall(candidates, cfg.anticallGlobal);
    if (!decision.reject) continue;

    try {
      await sock.rejectCall(call.id, call.from);
      const callerLabel = jidUserPart(candidates.find((c) => c.endsWith('@s.whatsapp.net')) || bareFrom);
      logger.security(
        'anticall',
        `Rejected incoming ${call.isVideo ? 'video' : 'voice'} call from +${callerLabel} (${decision.reason})`
      );

      const now = Date.now();
      const prevNotice = lastCallNoticeAt.get(bareFrom) || 0;
      if (now - prevNotice > 60_000 && !call.isGroup) {
        lastCallNoticeAt.set(bareFrom, now);
        await sock
          .sendMessage(call.from, {
            text: `*Anti-Call Active*\nCalls are currently disabled on this ${cfg.botName} account. Please send a text message instead.`,
          })
          .catch(() => {});
      }
    } catch (err) {
      logger.warn('anticall', `Failed rejecting call from ${call.from}: ${(err as Error).message}`);
    }
  }
}

export function getBotSnapshot() {
  const cfg = loadConfig();
  if (!persistedCacheLoaded) {
    persistedCacheLoaded = true;
    const mainAuthPath = path.join(cfg.sessionDir, 'main', 'creds.json');
    mainHasSavedCredsCache = fs.existsSync(mainAuthPath);
    if (fs.existsSync(cfg.sessionDir)) {
      for (const entry of fs.readdirSync(cfg.sessionDir, { withFileTypes: true })) {
        if (entry.isDirectory()) persistedSessionsCache.add(entry.name);
      }
    }
  }

  const subSessions: ActiveSessionInfo[] = [];
  for (const entry of vipSubSockets.values()) {
    subSessions.push(entry.info);
  }

  return {
    status: botState.status,
    qrDataUrl: botState.qrDataUrl,
    pairingCode: botState.pairingCode,
    pairingPhone: botState.pairingPhone,
    connectedUser: botState.connectedUser,
    lastError: botState.lastError,
    reconnectAttempts: botState.reconnectAttempts,
    hasSavedCreds: mainHasSavedCredsCache,
    uptimeSeconds: Math.floor((Date.now() - botState.startedAt) / 1000),
    subSessions,
    persistedSessions: Array.from(persistedSessionsCache),
  };
}

export async function resolveNewsletterMetadataFromActiveSockets(
  channelUrlOrJid: string
): Promise<{ jid: string; name?: string } | null> {
  const raw = String(channelUrlOrJid || '').trim();
  if (!raw) return null;

  const firstEntry = raw.split(/[\n,]+/).map((s) => s.trim()).find(Boolean) || '';
  if (!firstEntry) return null;
  if (firstEntry.includes('@newsletter')) {
    return { jid: firstEntry };
  }

  const inviteMatch = firstEntry.match(/whatsapp\.com\/channel\/(?:invite\/)?([A-Za-z0-9_-]+)/i);
  if (!inviteMatch) return null;
  const code = inviteMatch[1];

  const sockets: WASocket[] = [];
  if (mainSock && botState.status === 'connected') {
    sockets.push(mainSock);
  }
  for (const entry of vipSubSockets.values()) {
    if (entry.sock && entry.info.status === 'connected') {
      sockets.push(entry.sock);
    }
  }

  for (const sock of sockets) {
    if (typeof sock.newsletterMetadata !== 'function') continue;
    try {
      const meta = (await Promise.race([
        sock.newsletterMetadata('invite', code),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
      ])) as {
        id?: string;
        jid?: string;
        name?: string;
        subject?: string;
        thread_metadata?: { name?: { text?: string } };
      } | null;
      const jid = String(meta?.id || meta?.jid || '').trim();
      const name = String(
        meta?.thread_metadata?.name?.text || meta?.name || meta?.subject || ''
      ).trim();
      if (jid && jid.includes('@newsletter')) {
        return { jid, name: name || undefined };
      }
    } catch {
      // Try next active socket
    }
  }
  return null;
}

export async function startMainBot(options?: { pairingPhone?: string }): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (mainSock) {
    try {
      mainSock.end(undefined);
    } catch {
      // Ignore cleanup error
    }
    mainSock = null;
  }

  const cfg = loadConfig();
  const authDir = path.join(cfg.sessionDir, 'main');
  fs.mkdirSync(authDir, { recursive: true });

  botState.status = 'connecting';
  botState.lastError = null;
  botState.qrDataUrl = null;
  botState.pairingCode = null;
  botState.pairingPhone = options?.pairingPhone ? normalizePhone(options.pairingPhone) : null;
  if (options?.pairingPhone) {
    pendingFreshPairs.add('main');
  }

  try {
    const [{ state, saveCreds }, version] = await Promise.all([
      useMultiFileAuthState(authDir),
      getFastWaVersion(),
    ]);

    if (options?.pairingPhone && state.creds.registered) {
      botState.lastError =
        'Primary Bot already has an active saved session. Disconnect & Clear Session in Admin Panel → Logs & Health first, or use Multi-Device Session.';
      botState.status = mainSock ? 'connected' : 'idle';
      return;
    }

    const sock = makeWASocket({
      version,
      logger: silentPino as unknown as Parameters<typeof makeWASocket>[0]['logger'],
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          silentPino as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1]
        ),
      },
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: !cfg.singleTick,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
      keepAliveIntervalMs: 15_000,
      retryRequestDelayMs: 300,
      maxMsgRetryCount: 2,
      msgRetryCounterCache: sharedMsgRetryCache,
      placeholderResendCache: sharedPlaceholderResendCache,
      generateHighQualityLinkPreview: false,
      getMessage: getBaileysMessage,
      cachedGroupMetadata: getGroupMetadataFromCacheOnly,
    });

    mainSock = sock;
    registerSocketPlaceholderCache(sock, sharedPlaceholderResendCache);
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleAuthBackup('main', authDir);
    });

    let mainPairingTriggered = false;
    let mainFallbackTimer: NodeJS.Timeout | null = null;

    const triggerMainPairing = async () => {
      if (mainFallbackTimer) {
        clearTimeout(mainFallbackTimer);
        mainFallbackTimer = null;
      }
      if (mainPairingTriggered || !options?.pairingPhone || mainSock !== sock || sock.authState.creds.registered) {
        return;
      }
      mainPairingTriggered = true;
      const cleanPhone = normalizePhone(options.pairingPhone);
      try {
        const rawCode = await sock.requestPairingCode(cleanPhone);
        botState.pairingCode = formatPairingCode(rawCode);
        botState.status = 'pairing_ready';
        vipStore.recordPairingSuccess(cleanPhone);
        vipStore.logPairingAttempt({
          number: cleanPhone,
          status: 'authorized',
          reason: 'Main bot 8-digit pairing code generated',
          codePreview: `${botState.pairingCode.slice(0, 4)}-****`,
          source: 'dashboard',
        });
        logger.info('connection', `Generated 8-digit pairing code for +${cleanPhone}`);
      } catch (err) {
        botState.lastError = (err as Error).message;
        logger.error('connection', `Pairing code request failed: ${(err as Error).message}`);
      }
    };

    if (options?.pairingPhone && !state.creds.registered) {
      mainFallbackTimer = setTimeout(() => {
        void triggerMainPairing();
      }, 900);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && options?.pairingPhone && !mainPairingTriggered) {
        pendingFreshPairs.add('main');
        void triggerMainPairing();
      }

      if (qr && !options?.pairingPhone) {
        pendingFreshPairs.add('main');
        try {
          botState.qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            width: 280,
            color: { dark: '#0B0718', light: '#FFFFFF' },
          });
          botState.status = 'qr_ready';
          logger.info('connection', 'New WhatsApp QR code generated.');
        } catch (err) {
          logger.error('connection', `QR render failed: ${(err as Error).message}`);
        }
      }

      if (connection === 'open') {
        if (mainFallbackTimer) clearTimeout(mainFallbackTimer);
        botState.status = 'connected';
        botState.qrDataUrl = null;
        botState.pairingCode = null;
        botState.reconnectAttempts = 0;
        botState.lastError = null;
        const jid = sock.user?.id || '';
        const phone = normalizePhone(jid.split('@')[0].split(':')[0]);
        botState.connectedUser = {
          id: jid,
          name: sock.user?.name || cfg.botName,
          phone,
        };
        logger.info('connection', `${cfg.botName} connected successfully as +${phone}`);

        handleSessionOpenActions({
          sock,
          sessionKey: 'main',
          phone,
          authDir,
          isFreshPair: Boolean(options?.pairingPhone),
        });
      }

      if (connection === 'close') {
        if (mainFallbackTimer) clearTimeout(mainFallbackTimer);
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const reasonText = (lastDisconnect?.error as Error | undefined)?.message || 'Connection closed';
        botState.connectedUser = null;
        if (mainSock === sock) {
          mainSock = null;
        }

        if (isTerminalDisconnect(statusCode)) {
          pendingFreshPairs.delete('main');
          vipStore.markSessionStatus('main', 'logged_out');
          botState.status = 'logged_out';
          botState.qrDataUrl = null;
          botState.pairingCode = null;
          botState.reconnectAttempts = 0;
          botState.lastError =
            statusCode === DisconnectReason.connectionReplaced
              ? 'Session replaced by another device. Auto-reconnect halted cleanly.'
              : 'Device unlinked or logged out from WhatsApp. Reset main session and pair again.';
          logger.security(
            'connection',
            `Clean unlink/logout detected (code=${String(statusCode ?? 'unknown')}). Auto-reconnect halted.`
          );
          return;
        }

        // CRITICAL: On 515 restartRequired (immediately after pairing code/QR scan), reconnect instantly!
        if (statusCode === DisconnectReason.restartRequired) {
          botState.status = 'connecting';
          botState.lastError = null;
          logger.info('connection', 'WhatsApp pairing verified (515). Completing fast socket handshake...');
          reconnectTimer = setTimeout(() => {
            void startMainBot();
          }, 80);
          return;
        }

        vipStore.markSessionStatus('main', 'offline');
        botState.status = 'disconnected';
        botState.lastError = reasonText;

        if (hasSavedAuth(authDir)) {
          botState.reconnectAttempts += 1;
          const baseBackoff = Math.min(30_000, 1500 * Math.pow(1.6, Math.min(botState.reconnectAttempts - 1, 6)));
          const delayMs = baseBackoff + getRandomDelayMs(250, 900);

          logger.warn(
            'connection',
            `Disconnected (${reasonText}). 24/7 safe auto-reconnect attempt ${botState.reconnectAttempts} in ${Math.round(delayMs / 1000)}s...`
          );

          reconnectTimer = setTimeout(() => {
            void startMainBot();
          }, delayMs);
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        if (
          msg.key?.id &&
          msg.key?.remoteJid &&
          !msg.message &&
          (msg.key.isViewOnce ||
            msg.messageStubParameters?.some((p: string) => /view_once|absent/i.test(String(p))))
        ) {
          recordUnavailableViewOnceKey(msg.key);
          const cleanKey = sanitizeMessageKeyForPdo(msg.key);
          if (cleanKey && typeof sock.requestPlaceholderResend === 'function') {
            void sock.requestPlaceholderResend(cleanKey).catch(() => {});
          }
        }
        if (msg.key?.remoteJid === 'status@broadcast' && msg.message) {
          void recordBroadcastStatus(sock, msg);
        }
        cacheMessage(msg);
        void precacheViewOnceMedia(sock, msg);
        if (type === 'notify') {
          void handleIncomingMessage(sock, msg, getCachedMessage);
        }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const upd of updates) {
        if (upd.update?.message && upd.key?.remoteJid && upd.key?.id) {
          const synthetic: WAMessage = { key: upd.key, message: upd.update.message };
          if (upd.key.remoteJid === 'status@broadcast') {
            void recordBroadcastStatus(sock, synthetic);
          }
          cacheMessage(synthetic);
          void precacheViewOnceMedia(sock, synthetic);
        }
      }
    });

    sock.ev.on('messaging-history.set', ({ messages }) => {
      for (const msg of messages || []) {
        if (msg.key?.remoteJid === 'status@broadcast' && msg.message) {
          void recordBroadcastStatus(sock, msg);
        }
        cacheMessage(msg);
        void precacheViewOnceMedia(sock, msg);
      }
    });

    sock.ev.on('group-participants.update', async (update) => {
      await handleGroupParticipantsUpdate(sock, update);
    });

    sock.ev.on('groups.update', (updates) => {
      for (const g of updates) {
        if (g.id) invalidateGroupMetadataCache(g.id);
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        rememberUserName(c.id, c.notify || c.name || c.verifiedName);
      }
    });

    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts) {
        rememberUserName(c.id, c.notify || c.name || c.verifiedName);
      }
    });

    sock.ev.on('call', (calls) => {
      void handleIncomingCalls(sock, calls);
    });
  } catch (err) {
    botState.status = 'disconnected';
    botState.lastError = (err as Error).message;
    logger.error('connection', `Bot startup failure: ${(err as Error).message}`);
  }
}

export async function restartMainBot(): Promise<void> {
  logger.info('connection', 'Cleanly restarting main bot socket...');
  await startMainBot();
}

export async function disconnectMainBot(clearSession = false): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (mainSock) {
    try {
      if (clearSession) {
        await mainSock.logout().catch(() => {});
      }
      mainSock.end(undefined);
    } catch {
      // Ignore
    }
    mainSock = null;
  }
  if (clearSession) {
    const authDir = path.join(loadConfig().sessionDir, 'main');
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.mkdirSync(authDir, { recursive: true });
    deleteAuthBackupFromDb('main');
    mainHasSavedCredsCache = false;
    persistedSessionsCache.delete('main');
    pendingFreshPairs.delete('main');
    vipStore.markSessionStatus('main', 'logged_out');
  } else {
    vipStore.markSessionStatus('main', 'offline');
  }
  botState.status = 'idle';
  botState.qrDataUrl = null;
  botState.pairingCode = null;
  botState.connectedUser = null;
  botState.lastError = null;
  logger.info('connection', clearSession ? 'Main session cleared and stopped.' : 'Main bot stopped.');
}

async function connectSubSession(params: {
  sessionId: string;
  cleanPhone: string;
  authDir: string;
  reconnectAttempt?: number;
  existingInfo?: ActiveSessionInfo;
  requestPairingCode?: boolean;
}): Promise<{ sock: WASocket; info: ActiveSessionInfo; pairingCodePromise?: Promise<string> }> {
  const { sessionId, cleanPhone, authDir, reconnectAttempt = 0 } = params;

  const existingTimer = vipReconnectTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    vipReconnectTimers.delete(sessionId);
  }

  const existingSocket = vipSubSockets.get(sessionId);
  if (existingSocket) {
    try {
      existingSocket.sock.end(undefined);
    } catch {
      // Ignore cleanup error
    }
  }

  const [{ state, saveCreds }, version] = await Promise.all([
    useMultiFileAuthState(authDir),
    getFastWaVersion(),
  ]);

  const sock = makeWASocket({
    version,
    logger: silentPino as unknown as Parameters<typeof makeWASocket>[0]['logger'],
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        silentPino as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1]
      ),
    },
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: !loadConfig().singleTick,
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 300,
    maxMsgRetryCount: 2,
    msgRetryCounterCache: sharedMsgRetryCache,
    placeholderResendCache: sharedPlaceholderResendCache,
    generateHighQualityLinkPreview: false,
    getMessage: getBaileysMessage,
    cachedGroupMetadata: getGroupMetadataFromCacheOnly,
  });

  registerSocketPlaceholderCache(sock, sharedPlaceholderResendCache);

  const sessionInfo: ActiveSessionInfo = params.existingInfo || {
    sessionId,
    phone: cleanPhone,
    status: 'connecting',
    createdAt: new Date().toISOString(),
  };

  vipSubSockets.set(sessionId, { sock, info: sessionInfo });
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleAuthBackup(sessionId, authDir);
  });

  let pairingCodePromise: Promise<string> | undefined;
  if (params.requestPairingCode) {
    pairingCodePromise = new Promise<string>((resolve, reject) => {
      let settled = false;
      let requested = false;

      const executePairingRequest = async () => {
        if (settled || requested) return;
        requested = true;
        try {
          const raw = await sock.requestPairingCode(cleanPhone);
          settled = true;
          clearTimeout(fallbackTimer);
          clearTimeout(hardTimeout);
          resolve(formatPairingCode(raw));
        } catch (err) {
          settled = true;
          clearTimeout(fallbackTimer);
          clearTimeout(hardTimeout);
          reject(err);
        }
      };

      // Trigger immediately on QR event, or fast 850ms fallback
      const fallbackTimer = setTimeout(() => {
        void executePairingRequest();
      }, 850);

      const hardTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearTimeout(fallbackTimer);
          reject(new Error('WhatsApp handshake timed out. Please try again.'));
        }
      }, 15000);

      sock.ev.on('connection.update', (upd) => {
        if (upd.qr && !requested && !settled) {
          clearTimeout(fallbackTimer);
          void executePairingRequest();
        }
        if (upd.connection === 'close' && !settled) {
          clearTimeout(fallbackTimer);
          clearTimeout(hardTimeout);
          settled = true;
          reject(
            new Error(
              (upd.lastDisconnect?.error as Error | undefined)?.message ||
                'WhatsApp socket closed before pairing'
            )
          );
        }
      });
    });
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      sessionInfo.status = 'connected';
      const jid = sock.user?.id || '';
      const connectedPhone = normalizePhone(jid.split('@')[0].split(':')[0]) || cleanPhone;
      sessionInfo.connectedUser = {
        id: jid,
        name: sock.user?.name || `+${connectedPhone}`,
        phone: connectedPhone,
      };
      logger.info('pairing', `Session ${sessionId} connected to WhatsApp as +${connectedPhone}`);

      handleSessionOpenActions({
        sock,
        sessionKey: sessionId,
        phone: connectedPhone,
        authDir,
        isFreshPair: Boolean(params.requestPairingCode),
      });
    } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const reasonText = (lastDisconnect?.error as Error | undefined)?.message || 'Disconnected';

      if (isTerminalDisconnect(statusCode)) {
        sessionInfo.status = 'logged_out';
        vipSubSockets.delete(sessionId);
        pendingFreshPairs.delete(sessionId);
        vipStore.markSessionStatus(sessionId, 'logged_out');
        logger.security(
          'pairing',
          `Session ${sessionId} unlinked/logged out (code=${String(statusCode ?? 'unknown')}).`
        );
        return;
      }

      // CRITICAL FIX: WhatsApp drops the initial pairing socket with 515 (restartRequired)
      // right after the user enters the 8-digit code. Reconnect immediately so mobile doesn't
      // hang on "Logging in..."!
      if (statusCode === DisconnectReason.restartRequired) {
        sessionInfo.status = 'connecting';
        logger.info('pairing', `Pairing verified for +${cleanPhone} (515). Completing fast WhatsApp login...`);
        const timer = setTimeout(() => {
          void saveCreds()
            .catch(() => {})
            .finally(() => {
              void connectSubSession({
                sessionId,
                cleanPhone,
                authDir,
                reconnectAttempt: 0,
                existingInfo: sessionInfo,
                requestPairingCode: false,
              });
            });
        }, 50);
        vipReconnectTimers.set(sessionId, timer);
        return;
      }

      vipStore.markSessionStatus(sessionId, 'offline');
      if (hasSavedAuth(authDir)) {
        sessionInfo.status = 'connecting';
        const delayMs = Math.min(30_000, 1000 * Math.pow(1.6, Math.min(reconnectAttempt, 6))) + getRandomDelayMs(150, 500);
        logger.warn(
          'pairing',
          `Session ${sessionId} closed (${reasonText}). 24/7 safe auto-reconnect (${reconnectAttempt + 1}) in ${Math.round(delayMs / 1000)}s...`
        );
        const timer = setTimeout(() => {
          void connectSubSession({
            sessionId,
            cleanPhone,
            authDir,
            reconnectAttempt: reconnectAttempt + 1,
            existingInfo: sessionInfo,
            requestPairingCode: false,
          });
        }, delayMs);
        vipReconnectTimers.set(sessionId, timer);
      } else {
        sessionInfo.status = 'disconnected';
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) {
      if (
        m.key?.id &&
        m.key?.remoteJid &&
        !m.message &&
        (m.key.isViewOnce ||
          m.messageStubParameters?.some((p: string) => /view_once|absent/i.test(String(p))))
      ) {
        recordUnavailableViewOnceKey(m.key);
        const cleanKey = sanitizeMessageKeyForPdo(m.key);
        if (cleanKey && typeof sock.requestPlaceholderResend === 'function') {
          void sock.requestPlaceholderResend(cleanKey).catch(() => {});
        }
      }
      if (m.key?.remoteJid === 'status@broadcast' && m.message) {
        void recordBroadcastStatus(sock, m);
      }
      cacheMessage(m);
      void precacheViewOnceMedia(sock, m);
      if (type === 'notify') {
        void handleIncomingMessage(sock, m, getCachedMessage);
      }
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const upd of updates) {
      if (upd.update?.message && upd.key?.remoteJid && upd.key?.id) {
        const synthetic: WAMessage = { key: upd.key, message: upd.update.message };
        if (upd.key.remoteJid === 'status@broadcast') {
          void recordBroadcastStatus(sock, synthetic);
        }
        cacheMessage(synthetic);
        void precacheViewOnceMedia(sock, synthetic);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ messages }) => {
    for (const m of messages || []) {
      if (m.key?.remoteJid === 'status@broadcast' && m.message) {
        void recordBroadcastStatus(sock, m);
      }
      cacheMessage(m);
      void precacheViewOnceMedia(sock, m);
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    await handleGroupParticipantsUpdate(sock, update);
  });

  sock.ev.on('groups.update', (updates) => {
    for (const g of updates) {
      if (g.id) invalidateGroupMetadataCache(g.id);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      rememberUserName(c.id, c.notify || c.name || c.verifiedName);
    }
  });

  sock.ev.on('call', (calls) => {
    void handleIncomingCalls(sock, calls);
  });

  return { sock, info: sessionInfo, pairingCodePromise };
}

export async function requestVipSubPairingCode(
  phone: string,
  source: 'dashboard' | 'whatsapp_cmd'
): Promise<{ success: boolean; code?: string; sessionId?: string; error?: string }> {
  const cleanPhone = normalizePhone(phone);
  const cfg = loadConfig();
  const sessionId = `vip_${cleanPhone}`;
  const authDir = path.join(cfg.sessionDir, sessionId);

  try {
    const existingTimer = vipReconnectTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      vipReconnectTimers.delete(sessionId);
    }

    const existing = vipSubSockets.get(sessionId);
    if (existing) {
      try {
        existing.sock.end(undefined);
      } catch {
        // Ignore
      }
      vipSubSockets.delete(sessionId);
    }

    await fs.promises.rm(authDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.mkdir(authDir, { recursive: true });
    persistedSessionsCache.add(sessionId);
    pendingFreshPairs.add(sessionId);

    const { info, pairingCodePromise } = await connectSubSession({
      sessionId,
      cleanPhone,
      authDir,
      requestPairingCode: true,
    });

    const code = await pairingCodePromise!;
    info.status = 'pairing_ready';
    info.lastPairingCode = code;
    vipStore.recordPairingSuccess(cleanPhone);
    vipStore.logPairingAttempt({
      number: cleanPhone,
      status: 'authorized',
      reason: '8-digit WhatsApp pairing code generated',
      codePreview: `${code.slice(0, 4)}-****`,
      source,
    });
    logger.info('pairing', `8-digit code ready for +${cleanPhone}`);
    return { success: true, code, sessionId };
  } catch (err) {
    const errMsg = (err as Error).message || 'Pairing request failed';
    vipStore.logPairingAttempt({
      number: cleanPhone,
      status: 'error',
      reason: errMsg,
      source,
    });
    logger.error('pairing', `Pairing error for +${cleanPhone}: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

export async function sendDashboardBroadcast(text: string): Promise<{
  ok: boolean;
  sent: number;
  total: number;
  message: string;
}> {
  if (!mainSock || botState.status !== 'connected') {
    return {
      ok: false,
      sent: 0,
      total: 0,
      message: 'Connect the main WhatsApp bot session first to broadcast to live groups.',
    };
  }
  const cfg = loadConfig();
  const groupsMap = await mainSock.groupFetchAllParticipating();
  const allJids = Object.keys(groupsMap);

  if (allJids.length > cfg.maxBroadcastTargets) {
    logger.warn(
      'safetyGuard',
      `Dashboard broadcast targets (${allJids.length}) exceeded maxBroadcastTargets (${cfg.maxBroadcastTargets}). Capped safely.`
    );
  } else if (allJids.length >= Math.ceil(cfg.maxBroadcastTargets * 0.8)) {
    logger.warn(
      'safetyGuard',
      `Dashboard broadcast approaching target cap (${allJids.length}/${cfg.maxBroadcastTargets}).`
    );
  }

  const targetJids = allJids.slice(0, cfg.maxBroadcastTargets);
  let sent = 0;
  for (let i = 0; i < targetJids.length; i += 1) {
    const jid = targetJids[i];
    try {
      await mainSock.sendMessage(jid, { text: `*${cfg.botName} Broadcast*\n\n${text}` });
      sent += 1;
    } catch {
      // Skip failed group
    }
    if (i < targetJids.length - 1) {
      await new Promise((r) => setTimeout(r, getRandomDelayMs(cfg.broadcastDelayMinMs, cfg.broadcastDelayMaxMs)));
    }
  }
  return {
    ok: true,
    sent,
    total: targetJids.length,
    message: `Delivered safely to ${sent}/${targetJids.length} groups (${cfg.broadcastDelayMinMs}-${cfg.broadcastDelayMaxMs}ms random delay, cap ${cfg.maxBroadcastTargets}).`,
  };
}

let watchdogTimer: NodeJS.Timeout | null = null;
let watchdogRunning = false;

async function restoreSessionsInBatches(sessionNames: string[], sessionDir: string): Promise<void> {
  const BATCH_SIZE = 10;
  for (let i = 0; i < sessionNames.length; i += BATCH_SIZE) {
    const batch = sessionNames.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (name) => {
        const subDir = path.join(sessionDir, name);
        if (!(await hasSavedAuthAsync(subDir))) return;
        persistedSessionsCache.add(name);
        const cleanPhone = name.replace(/^vip_/, '');
        vipStore.recordConnectedSession({
          number: cleanPhone,
          name: `+${cleanPhone}`,
          sessionId: name,
          incrementCount: false,
          status: 'offline',
        });
        await connectSubSession({
          sessionId: name,
          cleanPhone,
          authDir: subDir,
          requestPairingCode: false,
        }).catch(() => {});
      })
    );
    if (i + BATCH_SIZE < sessionNames.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function ensureKeepAliveWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (watchdogRunning) return;
    watchdogRunning = true;
    void (async () => {
      try {
        const cfg = loadConfig();
        const mainAuthDir = path.join(cfg.sessionDir, 'main');
        const mainSaved = await hasSavedAuthAsync(mainAuthDir);
        mainHasSavedCredsCache = mainSaved;

        // Detect half-dead WebSocket that didn't fire close event on Railway
        if (botState.status === 'connected' && isSocketWsDead(mainSock)) {
          logger.warn('watchdog', 'Main WebSocket became stale/closed while marked connected. Reconnecting...');
          botState.status = 'disconnected';
          void startMainBot();
        } else if (
          mainSaved &&
          botState.status !== 'connected' &&
          botState.status !== 'connecting' &&
          botState.status !== 'qr_ready' &&
          botState.status !== 'pairing_ready' &&
          botState.status !== 'logged_out' &&
          !reconnectTimer
        ) {
          logger.warn('watchdog', 'Main bot session was offline without pending retry. Auto-reconnecting...');
          void startMainBot();
        }

        const entries = await fs.promises
          .readdir(cfg.sessionDir, { withFileTypes: true })
          .catch(() => []);
        const toRestore: string[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          persistedSessionsCache.add(entry.name);
          if (!entry.name.startsWith('vip_')) continue;
          const active = vipSubSockets.get(entry.name);
          const hasPending = vipReconnectTimers.has(entry.name);
          const subWsDead = Boolean(active && active.info.status === 'connected' && isSocketWsDead(active.sock));
          if (subWsDead && active) {
            active.info.status = 'disconnected';
          }
          if (
            (!active ||
              subWsDead ||
              (active.info.status !== 'connected' &&
                active.info.status !== 'connecting' &&
                active.info.status !== 'pairing_ready' &&
                active.info.status !== 'logged_out')) &&
            !hasPending
          ) {
            toRestore.push(entry.name);
          }
        }
        if (toRestore.length > 0) {
          await restoreSessionsInBatches(toRestore.slice(0, 20), cfg.sessionDir);
        }

        if (cfg.alwaysOnline && !cfg.singleTick) {
          if (mainSock && botState.status === 'connected') {
            void mainSock.sendPresenceUpdate('available').catch(() => {});
          }
          for (const entry of vipSubSockets.values()) {
            if (entry.info.status === 'connected') {
              void entry.sock.sendPresenceUpdate('available').catch(() => {});
            }
          }
        }
      } finally {
        watchdogRunning = false;
      }
    })();
  }, 25_000);
  if (typeof watchdogTimer.unref === 'function') {
    watchdogTimer.unref();
  }
}

export function closeAllSocketsGracefully(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const timer of vipReconnectTimers.values()) {
    clearTimeout(timer);
  }
  vipReconnectTimers.clear();

  if (mainSock) {
    try {
      mainSock.end(undefined);
    } catch {
      // Ignore
    }
    mainSock = null;
  }
  for (const entry of vipSubSockets.values()) {
    try {
      entry.sock.end(undefined);
    } catch {
      // Ignore
    }
  }
  vipSubSockets.clear();
}

export function initializeSavedSessionOnBoot(): void {
  const cfg = loadConfig();
  void getFastWaVersion();

  void (async () => {
    const restoredCount = await restoreAuthDirsFromDb(cfg.sessionDir);
    if (restoredCount > 0) {
      logger.info('boot', `Hydrated ${restoredCount} saved WhatsApp auth session(s) from database.`);
    }

    const mainAuthDir = path.join(cfg.sessionDir, 'main');
    if (await hasSavedAuthAsync(mainAuthDir)) {
      mainHasSavedCredsCache = true;
      persistedSessionsCache.add('main');
      try {
        const credsRaw = await fs.promises.readFile(path.join(mainAuthDir, 'creds.json'), 'utf-8');
        const creds = JSON.parse(credsRaw) as { me?: { id?: string; name?: string } };
        const mainPhone = normalizePhone((creds.me?.id || '').split('@')[0].split(':')[0]);
        if (mainPhone) {
          vipStore.recordConnectedSession({
            number: mainPhone,
            name: creds.me?.name || cfg.botName,
            sessionId: 'main',
            incrementCount: false,
            status: 'offline',
          });
        }
      } catch {
        // Ignore creds read failure
      }
      logger.info('boot', 'Found existing Main WhatsApp MD credentials. Auto-reconnecting...');
      void startMainBot();
    }

    const entries = await fs.promises
      .readdir(cfg.sessionDir, { withFileTypes: true })
      .catch(() => []);
    const subNames = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('vip_'))
      .map((e) => e.name);
    persistedCacheLoaded = true;
    if (subNames.length > 0) {
      logger.info('boot', `Restoring ${subNames.length} saved session(s) in fast batches...`);
      await restoreSessionsInBatches(subNames, cfg.sessionDir);
    }
  })();

  ensureKeepAliveWatchdog();
  startReminderScheduler(async (chatId, text, mentions) => {
    const targetSock =
      mainSock && botState.status === 'connected'
        ? mainSock
        : Array.from(vipSubSockets.values()).find((e) => e.info.status === 'connected')?.sock || null;
    if (!targetSock) return false;
    try {
      await targetSock.sendMessage(chatId, {
        text,
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
      });
      return true;
    } catch {
      return false;
    }
  });
  logger.info('boot', `${cfg.botName} ready for high-concurrency 8-digit code & QR pairing (24/7 watchdog active).`);
}
