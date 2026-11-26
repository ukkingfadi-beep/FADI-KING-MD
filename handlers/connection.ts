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
import { isValidPhone, loadConfig, normalizePhone } from '../config/bot.config.ts';
import { anticallStore } from '../utils/anticallStore.ts';
import {
  clearSessionChatData,
  getSessionChatMessages,
  getSessionMessageStats,
  listSessionChats,
  recordSessionChatMessage,
  removeSessionChatMessage,
  upsertSessionChatMeta,
  type LiveChatMediaType,
  type LiveChatMessage,
  type LiveChatThreadSummary,
} from '../utils/chatHistoryStore.ts';
import {
  inspectAndMitigateThreat,
  inspectMessagePayload,
  sanitizeMessageInPlace,
} from '../utils/crashGuard.ts';
import {
  backupAuthDirToDb,
  deleteAuthBackupFromDb,
  restoreAuthDirsFromDb,
} from '../utils/db.ts';
import {
  extractBodyText,
  extractChannelTargets,
  extractGroupInviteCode,
  extractGroupInviteCodes,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  getGroupMetadataFromCacheOnly,
  hasValidMediaPayload,
  invalidateGroupMetadataCache,
  isLidUser,
  isParticipantAdmin,
  jidUserPart,
  lookupKnownUserName,
  normalizeBareJid,
  rememberUserName,
  resolveSenderInfo,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import {
  convertWebAudioToWhatsAppVoice,
  downloadMessageMedia,
  getUnavailableViewOnceRecord,
  precacheViewOnceMedia,
  recordUnavailableViewOnceKey,
  registerSocketPlaceholderCache,
  sendImmediateViewOncePdo,
} from '../utils/mediaHelper.ts';
import { getRandomDelayMs } from '../utils/rateLimiter.ts';
import { startReminderScheduler } from '../utils/reminderStore.ts';
import {
  getOrDownloadStatusBuffer,
  getStatusById,
  hasGroupStatusMedia,
  listStatusesForDashboard,
  recordBroadcastStatus,
  type CachedStatusEntry,
  type DashboardStatusItem,
} from '../utils/statusStore.ts';
import { vipStore, type GroupConfig, type VipTier } from '../utils/vipStore.ts';
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

interface LiveMediaSummary {
  mediaType: LiveChatMediaType;
  displayText: string;
  mimetype?: string;
  fileName?: string;
  hasMedia?: boolean;
  ptt?: boolean;
  seconds?: number;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
}

const liveMediaBufferCache = new Map<
  string,
  { buffer: Buffer; mimetype: string; fileName: string; cachedAt: number }
>();

function cacheLiveMediaBuffer(
  cacheKey: string,
  buffer: Buffer,
  mimetype: string,
  fileName: string
): void {
  if (!cacheKey || !buffer || buffer.length === 0 || buffer.length > 16 * 1024 * 1024) return;
  liveMediaBufferCache.delete(cacheKey);
  liveMediaBufferCache.set(cacheKey, {
    buffer,
    mimetype,
    fileName,
    cachedAt: Date.now(),
  });
  let totalBytes = 0;
  for (const item of liveMediaBufferCache.values()) {
    totalBytes += item.buffer.length;
  }
  while (liveMediaBufferCache.size > 40 || totalBytes > 42 * 1024 * 1024) {
    const oldestKey = liveMediaBufferCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = liveMediaBufferCache.get(oldestKey);
    totalBytes -= evicted?.buffer.length || 0;
    liveMediaBufferCache.delete(oldestKey);
  }
}

function sanitizeDownloadFilename(name: string, fallbackExt = 'bin'): string {
  const cleaned = String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) return cleaned.slice(0, 120);
  return `whatsapp-media.${fallbackExt}`;
}

function extensionFromMime(mime: string): string {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/webm') return 'webm';
  if (m === 'audio/ogg' || m === 'application/ogg') return 'ogg';
  if (m === 'audio/mpeg') return 'mp3';
  if (m === 'audio/mp4' || m === 'audio/aac') return 'm4a';
  if (m === 'audio/wav') return 'wav';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('zip')) return 'zip';
  return 'bin';
}

function detectLiveMediaSummary(message: WAMessage['message']): LiveMediaSummary {
  const inner = unwrapMessage(message);
  if (!inner) return { mediaType: 'other', displayText: '' };

  const text = extractBodyText(message).trim();
  if (inner.imageMessage) {
    return {
      mediaType: 'image',
      displayText: text || '[Photo]',
      mimetype: inner.imageMessage.mimetype || 'image/jpeg',
      hasMedia: true,
    };
  }
  if (inner.videoMessage || inner.ptvMessage) {
    const v = inner.videoMessage || inner.ptvMessage;
    return {
      mediaType: 'video',
      displayText: text || '[Video]',
      mimetype: v?.mimetype || 'video/mp4',
      seconds: v?.seconds ?? undefined,
      hasMedia: true,
    };
  }
  if (inner.audioMessage) {
    const isPtt = Boolean(inner.audioMessage.ptt);
    return {
      mediaType: 'audio',
      displayText: text || (isPtt ? '[Voice Note]' : '[Audio]'),
      mimetype: inner.audioMessage.mimetype || 'audio/ogg; codecs=opus',
      ptt: isPtt,
      seconds: inner.audioMessage.seconds ?? undefined,
      hasMedia: true,
    };
  }
  if (inner.stickerMessage) {
    return {
      mediaType: 'sticker',
      displayText: '[Sticker]',
      mimetype: inner.stickerMessage.mimetype || 'image/webp',
      hasMedia: true,
    };
  }
  if (inner.documentMessage) {
    const fileName = inner.documentMessage.fileName || 'Document';
    return {
      mediaType: 'document',
      displayText: text || fileName,
      mimetype: inner.documentMessage.mimetype || 'application/octet-stream',
      fileName,
      hasMedia: true,
    };
  }
  if (inner.locationMessage || inner.liveLocationMessage) {
    const loc = inner.locationMessage || inner.liveLocationMessage;
    const lat = typeof loc?.degreesLatitude === 'number' ? loc.degreesLatitude : undefined;
    const lng = typeof loc?.degreesLongitude === 'number' ? loc.degreesLongitude : undefined;
    const locName = inner.locationMessage?.name || inner.locationMessage?.address || undefined;
    return {
      mediaType: 'location',
      displayText: text || locName || '[Shared Location]',
      locationLat: lat,
      locationLng: lng,
      locationName: locName,
    };
  }
  if (inner.contactMessage || inner.contactsArrayMessage) {
    const cName = inner.contactMessage?.displayName || 'Contact';
    return { mediaType: 'contact', displayText: `[Contact: ${cName}]` };
  }
  if (inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3) {
    const q =
      inner.pollCreationMessage?.name ||
      inner.pollCreationMessageV2?.name ||
      inner.pollCreationMessageV3?.name ||
      'Poll';
    return { mediaType: 'poll', displayText: `[Poll] ${q}` };
  }
  if (inner.requestPaymentMessage || inner.sendPaymentMessage) {
    return { mediaType: 'payment', displayText: text ? `[Payment] ${text}` : '[Payment Request]' };
  }
  if (text) {
    return { mediaType: 'text', displayText: text };
  }
  return { mediaType: 'other', displayText: '' };
}

async function recordSocketMessageToLiveStore(
  sock: WASocket,
  sessionKey: string,
  msg: WAMessage
): Promise<void> {
  try {
    const rawChatId = msg.key?.remoteJid;
    if (!rawChatId || rawChatId === 'status@broadcast' || !msg.message) return;
    if (msg.message.protocolMessage && !msg.message.editedMessage) return;

    const chatId = normalizeBareJid(rawChatId);
    if (!chatId || chatId === 'status@broadcast') return;

    const mediaSummary = detectLiveMediaSummary(msg.message);
    if (!mediaSummary.displayText) return;

    const isGroup = chatId.endsWith('@g.us');
    const fromMe = Boolean(msg.key?.fromMe);
    const { senderJid, senderNumber } = await resolveSenderInfo(sock, msg);

    if (!fromMe && msg.pushName) {
      rememberUserName(senderJid, msg.pushName);
      rememberUserName(senderNumber, msg.pushName);
      if (!isGroup) {
        rememberUserName(chatId, msg.pushName);
      }
    }

    const senderName = fromMe
      ? sock.user?.name || 'You'
      : msg.pushName || lookupKnownUserName(senderJid) || (senderNumber ? `+${senderNumber}` : 'User');

    let chatName: string | undefined;
    if (isGroup) {
      const cachedGroup = await getGroupMetadataFromCacheOnly(chatId);
      chatName = cachedGroup?.subject;
    } else if (!fromMe && msg.pushName) {
      chatName = msg.pushName;
    } else {
      chatName = lookupKnownUserName(chatId) || undefined;
    }

    const rawTs = Number(msg.messageTimestamp || 0);
    const timestamp =
      rawTs > 0 ? (rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs) : Date.now();

    recordSessionChatMessage(sessionKey, {
      id: msg.key?.id || `${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
      chatId,
      chatName,
      senderJid: senderJid || chatId,
      senderNumber: senderNumber || normalizePhone(jidUserPart(chatId)),
      senderName,
      fromMe,
      text: mediaSummary.displayText,
      mediaType: mediaSummary.mediaType,
      mimetype: mediaSummary.mimetype,
      fileName: mediaSummary.fileName,
      hasMedia: mediaSummary.hasMedia,
      ptt: mediaSummary.ptt,
      seconds: mediaSummary.seconds,
      locationLat: mediaSummary.locationLat,
      locationLng: mediaSummary.locationLng,
      locationName: mediaSummary.locationName,
      timestamp,
      key: msg.key?.id
        ? {
            remoteJid: rawChatId,
            id: msg.key.id,
            fromMe,
            ...(msg.key.participant ? { participant: msg.key.participant } : {}),
          }
        : undefined,
    });
  } catch {
    // Non-blocking chat history capture
  }
}

async function processSocketUpsertMessages(
  sock: WASocket,
  messages: WAMessage[],
  type: string,
  sessionKey = 'main'
): Promise<void> {
  for (const msg of messages) {
    try {
      if (msg.key?.remoteJid === 'status@broadcast' || hasGroupStatusMedia(msg.message)) {
        void recordBroadcastStatus(sock, msg, sessionKey);
      }
      if (
        msg.key?.id &&
        msg.key?.remoteJid &&
        msg.key.remoteJid !== 'status@broadcast' &&
        !msg.message &&
        (msg.key.isViewOnce ||
          msg.messageStubParameters?.some((p: string) => /view_once|absent/i.test(String(p))))
      ) {
        recordUnavailableViewOnceKey(msg.key);
        const unavail = getUnavailableViewOnceRecord(msg.key.id);
        if (unavail) {
          void sendImmediateViewOncePdo(sock, [unavail.cleanKey, ...unavail.altKeys]);
        }
      }

      if (msg.message && msg.key?.remoteJid !== 'status@broadcast') {
        const threatBlocked = await inspectAndMitigateThreat(sock, msg);
        if (threatBlocked) continue;
      }

      cacheMessage(msg);
      void precacheViewOnceMedia(sock, msg);
      void recordSocketMessageToLiveStore(sock, sessionKey, msg);
      if (type === 'notify') {
        void handleIncomingMessage(sock, msg, getCachedMessage);
      }
    } catch (err) {
      logger.warn('crashGuard', `Isolated message upsert error: ${(err as Error).message}`);
    }
  }
}

function processSocketMessageUpdates(
  sock: WASocket,
  updates: Array<{ key: WAMessageKey; update: { message?: WAMessage['message'] | null } }>,
  sessionKey = 'main'
): void {
  for (const upd of updates) {
    try {
      if (upd.update?.message && upd.key?.remoteJid && upd.key?.id) {
        const synthetic: WAMessage = { key: upd.key, message: upd.update.message };
        if (upd.key.remoteJid !== 'status@broadcast') {
          const check = inspectMessagePayload(upd.update.message);
          if (check.isThreat) {
            sanitizeMessageInPlace(synthetic);
            void inspectAndMitigateThreat(sock, { key: upd.key, message: upd.update.message });
            continue;
          }
        }
        if (upd.key.remoteJid === 'status@broadcast' || hasGroupStatusMedia(upd.update.message)) {
          void recordBroadcastStatus(sock, synthetic, sessionKey);
        }
        cacheMessage(synthetic);
        void precacheViewOnceMedia(sock, synthetic);
        void recordSocketMessageToLiveStore(sock, sessionKey, synthetic);
      }
    } catch (err) {
      logger.warn('crashGuard', `Isolated message update error: ${(err as Error).message}`);
    }
  }
}

export function getPreferredActiveSocket(): WASocket | null {
  if (mainSock && botState.status === 'connected') return mainSock;
  for (const entry of vipSubSockets.values()) {
    if (entry.info.status === 'connected') return entry.sock;
  }
  return mainSock;
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
      void processSocketUpsertMessages(sock, messages, type, 'main');
    });

    sock.ev.on('messages.update', (updates) => {
      processSocketMessageUpdates(sock, updates, 'main');
    });

    sock.ev.on('messaging-history.set', ({ chats, messages }) => {
      for (const c of chats || []) {
        if (c.id && c.id !== 'status@broadcast') {
          upsertSessionChatMeta(
            'main',
            normalizeBareJid(c.id),
            c.name || undefined,
            c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined
          );
        }
      }
      for (const msg of messages || []) {
        try {
          if (msg.message && msg.key?.remoteJid !== 'status@broadcast') {
            const check = inspectMessagePayload(msg.message);
            if (check.isThreat) {
              sanitizeMessageInPlace(msg);
              continue;
            }
          }
          if (msg.key?.remoteJid === 'status@broadcast' || hasGroupStatusMedia(msg.message)) {
            void recordBroadcastStatus(sock, msg, 'main');
          }
          cacheMessage(msg);
          void precacheViewOnceMedia(sock, msg);
          void recordSocketMessageToLiveStore(sock, 'main', msg);
        } catch {
          // Ignore malformed history sync item
        }
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        if (c.id && c.id !== 'status@broadcast') {
          upsertSessionChatMeta(
            'main',
            normalizeBareJid(c.id),
            c.name || undefined,
            c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined
          );
        }
      }
    });

    sock.ev.on('chats.update', (updates) => {
      for (const c of updates) {
        if (c.id && c.id !== 'status@broadcast') {
          upsertSessionChatMeta(
            'main',
            normalizeBareJid(c.id),
            c.name || undefined,
            c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined
          );
        }
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
    void processSocketUpsertMessages(sock, messages, type, sessionId);
  });

  sock.ev.on('messages.update', (updates) => {
    processSocketMessageUpdates(sock, updates, sessionId);
  });

  sock.ev.on('messaging-history.set', ({ chats, messages }) => {
    for (const c of chats || []) {
      if (c.id && c.id !== 'status@broadcast') {
        upsertSessionChatMeta(
          sessionId,
          normalizeBareJid(c.id),
          c.name || undefined,
          c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined
        );
      }
    }
    for (const m of messages || []) {
      try {
        if (m.message && m.key?.remoteJid !== 'status@broadcast') {
          const check = inspectMessagePayload(m.message);
          if (check.isThreat) {
            sanitizeMessageInPlace(m);
            continue;
          }
        }
        if (m.key?.remoteJid === 'status@broadcast' || hasGroupStatusMedia(m.message)) {
          void recordBroadcastStatus(sock, m, sessionId);
        }
        cacheMessage(m);
        void precacheViewOnceMedia(sock, m);
        void recordSocketMessageToLiveStore(sock, sessionId, m);
      } catch {
        // Ignore malformed history sync item
      }
    }
  });

  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) {
      if (c.id && c.id !== 'status@broadcast') {
        upsertSessionChatMeta(
          sessionId,
          normalizeBareJid(c.id),
          c.name || undefined,
          c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined
        );
      }
    }
  });

  sock.ev.on('chats.update', (updates) => {
    for (const c of updates) {
      if (c.id && c.id !== 'status@broadcast') {
        upsertSessionChatMeta(
          sessionId,
          normalizeBareJid(c.id),
          c.name || undefined,
          c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined
        );
      }
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
  logger.info('boot', `Baileys auth session directory: ${cfg.sessionDir}`);

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

// ============================================================================
// LIVE CHAT & FULL USER WHATSAPP / GROUP ADMIN CONTROL
// ============================================================================

export type LiveSessionState =
  | 'active'
  | 'connecting'
  | 'offline'
  | 'logged_out'
  | 'not_paired';

export interface LiveControlUserEntry {
  number: string;
  name: string;
  tier: VipTier | 'paired';
  sessionId: string | null;
  liveStatus: LiveSessionState;
  online: boolean;
  pairingCount: number;
  lastPairedAt?: string;
  chatCount: number;
  messageCount: number;
  lastActivityAt: number;
  canReconnect: boolean;
  canDisconnect: boolean;
}

export interface LiveControlOverview {
  counts: {
    totalUsers: number;
    pairedCount: number;
    notPairedCount: number;
    activeCount: number;
    inactiveCount: number;
    loggedOutCount: number;
    mainConnected: boolean;
    activeSubSessions: number;
  };
  users: LiveControlUserEntry[];
}

export interface LiveChatThreadView extends LiveChatThreadSummary {
  participantCount?: number;
  adminCount?: number;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  announce?: boolean;
  restrict?: boolean;
}

export interface LiveGroupParticipantView {
  jid: string;
  lid?: string;
  phone: string;
  name: string;
  role: 'superadmin' | 'admin' | 'member';
  isSelf: boolean;
}

export interface LiveGroupDetailView {
  id: string;
  subject: string;
  desc: string;
  owner: string;
  creation?: number;
  announce: boolean;
  restrict: boolean;
  isBotAdmin: boolean;
  isBotSuperAdmin: boolean;
  participantCount: number;
  adminCount: number;
  botConfig: GroupConfig;
  participants: LiveGroupParticipantView[];
}

function getLiveSessionSocket(sessionId: string): {
  sock: WASocket | null;
  status: ConnectionStatus;
  phone: string;
  name: string;
} {
  const cleanId = String(sessionId || '').trim();
  if (cleanId === 'main') {
    return {
      sock: mainSock,
      status: botState.status,
      phone: botState.connectedUser?.phone || '',
      name: botState.connectedUser?.name || loadConfig().botName,
    };
  }
  const direct = vipSubSockets.get(cleanId);
  if (direct) {
    return {
      sock: direct.sock,
      status: direct.info.status,
      phone: direct.info.connectedUser?.phone || direct.info.phone,
      name: direct.info.connectedUser?.name || `+${direct.info.phone}`,
    };
  }
  const cleanPhone = normalizePhone(cleanId.replace(/^vip_/, ''));
  if (cleanPhone) {
    if (botState.connectedUser?.phone === cleanPhone && mainSock) {
      return {
        sock: mainSock,
        status: botState.status,
        phone: cleanPhone,
        name: botState.connectedUser.name,
      };
    }
    const byPhone = vipSubSockets.get(`vip_${cleanPhone}`);
    if (byPhone) {
      return {
        sock: byPhone.sock,
        status: byPhone.info.status,
        phone: byPhone.info.connectedUser?.phone || byPhone.info.phone,
        name: byPhone.info.connectedUser?.name || `+${byPhone.info.phone}`,
      };
    }
  }
  return { sock: null, status: 'idle', phone: cleanPhone || '', name: '' };
}

export function getLiveControlOverview(): LiveControlOverview {
  const cfg = loadConfig();
  const snap = getBotSnapshot();
  const vips = vipStore.listVips().filter((v) => v.active);
  const pairedUsers = vipStore.listPairedUsers();

  const map = new Map<string, LiveControlUserEntry>();

  // 1. Seed from VIP Whitelist (defaults to not_paired until paired session is found)
  for (const vip of vips) {
    const clean = normalizePhone(vip.number);
    if (!clean) continue;
    const expectedSubId = `vip_${clean}`;
    const hasSavedSub = persistedSessionsCache.has(expectedSubId) || hasSavedAuth(path.join(cfg.sessionDir, expectedSubId));
    const hasPairedBefore = (vip.pairingCount || 0) > 0 || hasSavedSub;
    map.set(clean, {
      number: clean,
      name: vip.name || `VIP ${clean.slice(-4)}`,
      tier: vip.tier,
      sessionId: hasSavedSub ? expectedSubId : null,
      liveStatus: hasPairedBefore ? 'offline' : 'not_paired',
      online: false,
      pairingCount: vip.pairingCount || 0,
      lastPairedAt: vip.lastPairedAt,
      chatCount: 0,
      messageCount: 0,
      lastActivityAt: 0,
      canReconnect: hasSavedSub,
      canDisconnect: hasSavedSub,
    });
  }

  // 2. Merge persisted paired users registry
  for (const p of pairedUsers) {
    const clean = normalizePhone(p.number);
    if (!clean) continue;
    const existing = map.get(clean);
    const sid = p.sessionId || `vip_${clean}`;
    const hasAuth =
      sid === 'main'
        ? hasSavedAuth(path.join(cfg.sessionDir, 'main'))
        : hasSavedAuth(path.join(cfg.sessionDir, sid));

    const derivedStatus: LiveSessionState =
      p.status === 'connected'
        ? 'offline'
        : p.status === 'logged_out'
          ? 'logged_out'
          : 'offline';

    map.set(clean, {
      number: clean,
      name:
        (existing?.name && !existing.name.startsWith('+') ? existing.name : '') ||
        p.name ||
        existing?.name ||
        `+${clean}`,
      tier: existing?.tier || 'paired',
      sessionId: sid,
      liveStatus: derivedStatus,
      online: false,
      pairingCount: Math.max(existing?.pairingCount || 0, p.pairingCount || 1),
      lastPairedAt: p.lastPairedAt || existing?.lastPairedAt,
      chatCount: 0,
      messageCount: 0,
      lastActivityAt: 0,
      canReconnect: hasAuth,
      canDisconnect: hasAuth,
    });
  }

  // 3. Overlay live sub-sessions
  for (const sub of snap.subSessions) {
    const clean = normalizePhone(sub.connectedUser?.phone || sub.phone);
    if (!clean) continue;
    const existing = map.get(clean);
    const hasAuth = hasSavedAuth(path.join(cfg.sessionDir, sub.sessionId));
    const liveStatus: LiveSessionState =
      sub.status === 'connected'
        ? 'active'
        : sub.status === 'connecting' || sub.status === 'pairing_ready'
          ? 'connecting'
          : sub.status === 'logged_out'
            ? 'logged_out'
            : 'offline';

    map.set(clean, {
      number: clean,
      name:
        (existing?.name && !existing.name.startsWith('+') ? existing.name : '') ||
        sub.connectedUser?.name ||
        existing?.name ||
        `+${clean}`,
      tier: existing?.tier || 'paired',
      sessionId: sub.sessionId,
      liveStatus,
      online: liveStatus === 'active',
      pairingCount: Math.max(existing?.pairingCount || 0, 1),
      lastPairedAt: existing?.lastPairedAt || sub.createdAt,
      chatCount: 0,
      messageCount: 0,
      lastActivityAt: 0,
      canReconnect: !['active', 'connecting'].includes(liveStatus) && hasAuth,
      canDisconnect: liveStatus === 'active' || liveStatus === 'connecting' || hasAuth,
    });
  }

  // 4. Overlay persisted vip_* folders that might not be in vipSubSockets yet
  for (const sessName of snap.persistedSessions) {
    if (!sessName.startsWith('vip_')) continue;
    const clean = normalizePhone(sessName.replace(/^vip_/, ''));
    if (!clean) continue;
    const existing = map.get(clean);
    const hasAuth = hasSavedAuth(path.join(cfg.sessionDir, sessName));
    if (!existing) {
      map.set(clean, {
        number: clean,
        name: lookupKnownUserName(clean) || `+${clean}`,
        tier: 'paired',
        sessionId: sessName,
        liveStatus: hasAuth ? 'offline' : 'logged_out',
        online: false,
        pairingCount: 1,
        chatCount: 0,
        messageCount: 0,
        lastActivityAt: 0,
        canReconnect: hasAuth,
        canDisconnect: hasAuth,
      });
    } else if (!existing.sessionId) {
      existing.sessionId = sessName;
      existing.canReconnect = !existing.online && hasAuth;
      existing.canDisconnect = existing.online || hasAuth;
      if (existing.liveStatus === 'not_paired' && hasAuth) {
        existing.liveStatus = 'offline';
      }
    }
  }

  // 5. Overlay Primary Bot ('main') session
  const mainPhone = normalizePhone(
    snap.connectedUser?.phone || snap.pairingPhone || ''
  );
  if (mainPhone && (snap.status === 'connected' || snap.status === 'connecting' || snap.hasSavedCreds)) {
    const existing = map.get(mainPhone);
    const liveStatus: LiveSessionState =
      snap.status === 'connected'
        ? 'active'
        : snap.status === 'connecting' || snap.status === 'pairing_ready' || snap.status === 'qr_ready'
          ? 'connecting'
          : snap.status === 'logged_out'
            ? 'logged_out'
            : 'offline';

    map.set(mainPhone, {
      number: mainPhone,
      name:
        (existing?.name && !existing.name.startsWith('+') ? existing.name : '') ||
        snap.connectedUser?.name ||
        existing?.name ||
        cfg.botName,
      tier: existing?.tier || 'owner',
      sessionId: 'main',
      liveStatus,
      online: liveStatus === 'active',
      pairingCount: Math.max(existing?.pairingCount || 0, 1),
      lastPairedAt: existing?.lastPairedAt || new Date().toISOString(),
      chatCount: 0,
      messageCount: 0,
      lastActivityAt: 0,
      canReconnect: !['active', 'connecting'].includes(liveStatus) && snap.hasSavedCreds,
      canDisconnect: liveStatus === 'active' || liveStatus === 'connecting' || snap.hasSavedCreds,
    });
  }

  // 6. Attach live chat stats to every session
  const users = Array.from(map.values()).map((u) => {
    if (u.sessionId) {
      const stats = getSessionMessageStats(u.sessionId);
      return {
        ...u,
        chatCount: stats.chatCount,
        messageCount: stats.messageCount,
        lastActivityAt: stats.lastActivityAt,
      };
    }
    return u;
  });

  const rank: Record<LiveSessionState, number> = {
    active: 0,
    connecting: 1,
    offline: 2,
    logged_out: 3,
    not_paired: 4,
  };

  users.sort((a, b) => {
    if (rank[a.liveStatus] !== rank[b.liveStatus]) {
      return rank[a.liveStatus] - rank[b.liveStatus];
    }
    if (a.sessionId === 'main' && b.sessionId !== 'main') return -1;
    if (b.sessionId === 'main' && a.sessionId !== 'main') return 1;
    if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return (b.lastPairedAt || '').localeCompare(a.lastPairedAt || '');
  });

  const activeCount = users.filter((u) => u.liveStatus === 'active').length;
  const notPairedCount = users.filter((u) => u.liveStatus === 'not_paired').length;
  const pairedCount = users.length - notPairedCount;
  const inactiveCount = pairedCount - activeCount;
  const loggedOutCount = users.filter((u) => u.liveStatus === 'logged_out').length;
  const activeSubSessions = snap.subSessions.filter((s) => s.status === 'connected').length;

  return {
    counts: {
      totalUsers: users.length,
      pairedCount,
      notPairedCount,
      activeCount,
      inactiveCount,
      loggedOutCount,
      mainConnected: snap.status === 'connected',
      activeSubSessions,
    },
    users,
  };
}

export async function getSessionChatsOverview(sessionId: string): Promise<{
  ok: boolean;
  error?: string;
  session: {
    sessionId: string;
    phone: string;
    name: string;
    status: ConnectionStatus;
    connected: boolean;
  };
  stats: {
    totalChats: number;
    dmCount: number;
    groupCount: number;
    adminGroupCount: number;
  };
  chats: LiveChatThreadView[];
}> {
  const { sock, status, phone, name } = getLiveSessionSocket(sessionId);
  const storedChats = listSessionChats(sessionId);
  const storedMap = new Map(storedChats.map((c) => [c.chatId, c]));

  const connected = Boolean(sock && status === 'connected');
  const merged = new Map<string, LiveChatThreadView>();

  // Seed DM chats & any stored threads first
  for (const t of storedChats) {
    merged.set(t.chatId, {
      ...t,
      name:
        t.chatType === 'dm'
          ? lookupKnownUserName(t.chatId) || t.name || (t.phone ? `+${t.phone}` : t.chatId)
          : t.name,
    });
  }

  let liveGroupsCount = 0;
  let adminGroupCount = 0;

  if (sock && connected) {
    try {
      const [groupsMap, botJids] = await Promise.all([
        Promise.race([
          sock.groupFetchAllParticipating(),
          new Promise<Record<string, never>>((_, reject) =>
            setTimeout(() => reject(new Error('Group fetch timed out')), 8000)
          ),
        ]),
        getBotJids(sock),
      ]);

      for (const [gid, meta] of Object.entries(groupsMap)) {
        const me = findParticipant(meta.participants || [], botJids);
        const isAdmin = isParticipantAdmin(me);
        const isSuperAdmin = me?.admin === 'superadmin';
        const adminCount = (meta.participants || []).filter((p) => isParticipantAdmin(p)).length;
        const stored = storedMap.get(gid);
        const creationTs = meta.creation ? Number(meta.creation) * 1000 : 0;

        liveGroupsCount += 1;
        if (isAdmin) adminGroupCount += 1;

        merged.set(gid, {
          chatId: gid,
          chatType: 'group',
          name: meta.subject || stored?.name || gid,
          phone: '',
          lastMessage: stored?.lastMessage || (meta.desc ? meta.desc.slice(0, 120) : ''),
          lastSenderName: stored?.lastSenderName || '',
          lastFromMe: stored?.lastFromMe || false,
          lastTimestamp: stored?.lastTimestamp || creationTs || 0,
          messageCount: stored?.messageCount || 0,
          participantCount: meta.participants?.length || meta.size || 0,
          adminCount,
          isAdmin,
          isSuperAdmin,
          announce: Boolean(meta.announce),
          restrict: Boolean(meta.restrict),
        });
      }
    } catch (err) {
      logger.warn('liveChat', `Group fetch warning for ${sessionId}: ${(err as Error).message}`);
    }
  }

  const chats = Array.from(merged.values()).sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return b.lastTimestamp - a.lastTimestamp;
  });

  const dmCount = chats.filter((c) => c.chatType === 'dm').length;
  const groupCount = Math.max(liveGroupsCount, chats.filter((c) => c.chatType === 'group').length);

  return {
    ok: true,
    session: {
      sessionId,
      phone,
      name,
      status,
      connected,
    },
    stats: {
      totalChats: chats.length,
      dmCount,
      groupCount,
      adminGroupCount,
    },
    chats,
  };
}

export function getSessionChatHistory(
  sessionId: string,
  chatId: string,
  limit = 100
): LiveChatMessage[] {
  return getSessionChatMessages(sessionId, normalizeBareJid(chatId), limit);
}

export async function getSessionGroupDetail(
  sessionId: string,
  groupId: string
): Promise<{ ok: boolean; error?: string; group?: LiveGroupDetailView }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected user WhatsApp session is offline.' };
  }

  try {
    const cleanGroupId = normalizeBareJid(groupId);
    const [meta, botJids] = await Promise.all([
      getCachedGroupMetadata(sock, cleanGroupId, true),
      getBotJids(sock),
    ]);
    const botPartsSet = new Set(botJids.map((j) => jidUserPart(j)));
    const me = findParticipant(meta.participants || [], botJids);
    const isBotAdmin = isParticipantAdmin(me);
    const isBotSuperAdmin = me?.admin === 'superadmin';

    const participants: LiveGroupParticipantView[] = await Promise.all(
      (meta.participants || []).map(async (p) => {
        const bareId = normalizeBareJid(p.id);
        let pnJid = p.phoneNumber ? normalizeBareJid(p.phoneNumber) : '';
        if (!pnJid && bareId.endsWith('@s.whatsapp.net')) {
          pnJid = bareId;
        } else if (!pnJid && isLidUser(bareId) && sock.signalRepository?.lidMapping?.getPNForLID) {
          try {
            const mapped = await sock.signalRepository.lidMapping.getPNForLID(bareId);
            if (mapped) pnJid = normalizeBareJid(mapped);
          } catch {
            // Ignore missing mapping
          }
        }
        const phone = normalizePhone(jidUserPart(pnJid || bareId));
        const name =
          lookupKnownUserName(pnJid || bareId) ||
          lookupKnownUserName(p.lid) ||
          (phone ? `+${phone}` : bareId);
        const role: 'superadmin' | 'admin' | 'member' =
          p.admin === 'superadmin'
            ? 'superadmin'
            : isParticipantAdmin(p)
              ? 'admin'
              : 'member';
        const isSelf =
          botPartsSet.has(jidUserPart(bareId)) ||
          (pnJid ? botPartsSet.has(jidUserPart(pnJid)) : false) ||
          (p.lid ? botPartsSet.has(jidUserPart(p.lid)) : false);

        return {
          jid: bareId,
          lid: p.lid ? normalizeBareJid(p.lid) : undefined,
          phone,
          name,
          role,
          isSelf,
        };
      })
    );

    const roleOrder = { superadmin: 0, admin: 1, member: 2 };
    participants.sort((a, b) => {
      if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
      return a.name.localeCompare(b.name);
    });

    const adminCount = participants.filter((p) => p.role !== 'member').length;

    return {
      ok: true,
      group: {
        id: cleanGroupId,
        subject: meta.subject || cleanGroupId,
        desc: meta.desc || '',
        owner: meta.owner ? normalizeBareJid(meta.owner) : '',
        creation: meta.creation,
        announce: Boolean(meta.announce),
        restrict: Boolean(meta.restrict),
        isBotAdmin,
        isBotSuperAdmin,
        participantCount: participants.length,
        adminCount,
        botConfig: vipStore.getGroupConfig(cleanGroupId),
        participants,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to load group details.' };
  }
}

export async function sendSessionLiveMessage(
  sessionId: string,
  targetJidOrPhone: string,
  text: string
): Promise<{ ok: boolean; error?: string; chatId?: string; message?: LiveChatMessage }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return { ok: false, error: 'Message text cannot be empty.' };
  }

  let targetJid = String(targetJidOrPhone || '').trim();
  if (!targetJid.includes('@')) {
    const cleanPhone = normalizePhone(targetJid);
    if (!isValidPhone(cleanPhone)) {
      return { ok: false, error: 'Enter a valid WhatsApp phone number or JID.' };
    }
    targetJid = `${cleanPhone}@s.whatsapp.net`;
  } else {
    targetJid = normalizeBareJid(targetJid);
  }

  try {
    const sent = await sock.sendMessage(targetJid, { text: cleanText });
    const now = Date.now();
    const myJid = normalizeBareJid(sock.user?.id || '');
    const myPhone = normalizePhone(jidUserPart(myJid));
    const entry: LiveChatMessage = {
      id: sent?.key?.id || `out_${now}_${Math.random().toString(36).slice(2, 6)}`,
      chatId: targetJid,
      senderJid: myJid || targetJid,
      senderNumber: myPhone,
      senderName: sock.user?.name || 'You',
      fromMe: true,
      text: cleanText,
      mediaType: 'text',
      timestamp: now,
      key: sent?.key?.id
        ? {
            remoteJid: targetJid,
            id: sent.key.id,
            fromMe: true,
          }
        : undefined,
    };
    recordSessionChatMessage(sessionId, {
      ...entry,
      chatName: lookupKnownUserName(targetJid) || undefined,
    });
    logger.info('liveChat', `Admin sent message via ${sessionId} to ${targetJid}`);
    return { ok: true, chatId: targetJid, message: entry };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to send message.' };
  }
}

export async function deleteSessionLiveMessage(
  sessionId: string,
  chatId: string,
  msgId: string,
  fromMe: boolean,
  participant?: string
): Promise<{ ok: boolean; error?: string }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }
  const cleanChat = normalizeBareJid(chatId);
  try {
    await sock.sendMessage(cleanChat, {
      delete: {
        remoteJid: cleanChat,
        id: msgId,
        fromMe: Boolean(fromMe),
        ...(participant ? { participant } : {}),
      },
    });
    removeSessionChatMessage(sessionId, cleanChat, msgId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Could not delete message.' };
  }
}

export async function executeSessionGroupAction(
  sessionId: string,
  groupId: string,
  action:
    | 'promote'
    | 'demote'
    | 'add'
    | 'remove'
    | 'mute'
    | 'unmute'
    | 'lock'
    | 'unlock'
    | 'subject'
    | 'description'
    | 'invite'
    | 'revoke'
    | 'leave',
  payload?: { targets?: string[]; subject?: string; description?: string }
): Promise<{ ok: boolean; message?: string; error?: string; inviteUrl?: string }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }
  const cleanGroup = normalizeBareJid(groupId);
  if (!cleanGroup.endsWith('@g.us')) {
    return { ok: false, error: 'Invalid group JID.' };
  }

  try {
    if (action === 'promote' || action === 'demote' || action === 'remove' || action === 'add') {
      const rawTargets = Array.isArray(payload?.targets) ? payload.targets : [];
      const jids = Array.from(
        new Set(
          rawTargets
            .map((t) => {
              const s = String(t || '').trim();
              if (!s) return '';
              if (s.includes('@')) return normalizeBareJid(s);
              const digits = normalizePhone(s);
              return isValidPhone(digits) ? `${digits}@s.whatsapp.net` : '';
            })
            .filter(Boolean)
        )
      );
      if (jids.length === 0) {
        return { ok: false, error: 'Provide at least one valid member or phone number.' };
      }

      const result = await sock.groupParticipantsUpdate(cleanGroup, jids, action);
      invalidateGroupMetadataCache(cleanGroup);

      if (action === 'add') {
        const failed = (result || []).filter((r) => String(r.status) !== '200');
        if (failed.length === jids.length) {
          const code = failed[0]?.status || 'blocked';
          return {
            ok: false,
            error: `WhatsApp returned status ${code} (privacy settings or already added/unavailable).`,
          };
        }
      }

      const verbMap = {
        promote: 'Promoted to Admin',
        demote: 'Removed from Admin',
        add: 'Added to group',
        remove: 'Removed from group',
      };
      logger.info('liveChat', `${verbMap[action]} (${jids.join(', ')}) in ${cleanGroup} via ${sessionId}`);
      return { ok: true, message: `${verbMap[action]} successfully.` };
    }

    if (action === 'mute' || action === 'unmute') {
      await sock.groupSettingUpdate(cleanGroup, action === 'mute' ? 'announcement' : 'not_announcement');
      invalidateGroupMetadataCache(cleanGroup);
      return {
        ok: true,
        message: action === 'mute' ? 'Group muted (Admins Only).' : 'Group opened (Everyone can send).',
      };
    }

    if (action === 'lock' || action === 'unlock') {
      await sock.groupSettingUpdate(cleanGroup, action === 'lock' ? 'locked' : 'unlocked');
      invalidateGroupMetadataCache(cleanGroup);
      return {
        ok: true,
        message: action === 'lock' ? 'Group info locked to Admins.' : 'Group info unlocked.',
      };
    }

    if (action === 'subject') {
      const subject = String(payload?.subject || '').trim();
      if (!subject) return { ok: false, error: 'Group subject cannot be empty.' };
      await sock.groupUpdateSubject(cleanGroup, subject);
      invalidateGroupMetadataCache(cleanGroup);
      return { ok: true, message: 'Group subject updated.' };
    }

    if (action === 'description') {
      await sock.groupUpdateDescription(cleanGroup, String(payload?.description || ''));
      invalidateGroupMetadataCache(cleanGroup);
      return { ok: true, message: 'Group description updated.' };
    }

    if (action === 'invite' || action === 'revoke') {
      const code =
        action === 'revoke'
          ? await sock.groupRevokeInvite(cleanGroup)
          : await sock.groupInviteCode(cleanGroup);
      const inviteUrl = code ? `https://chat.whatsapp.com/${code}` : '';
      return {
        ok: true,
        inviteUrl,
        message: action === 'revoke' ? 'New group invite link generated.' : 'Invite link fetched.',
      };
    }

    if (action === 'leave') {
      await sock.groupLeave(cleanGroup);
      invalidateGroupMetadataCache(cleanGroup);
      return { ok: true, message: 'Left the group successfully.' };
    }

    return { ok: false, error: 'Unknown group action.' };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Group admin action failed.' };
  }
}

export async function executeSessionAccountAction(
  sessionId: string,
  action: 'reconnect' | 'disconnect' | 'logout' | 'join_group' | 'block' | 'unblock' | 'presence',
  payload?: { inviteCode?: string; target?: string; presence?: 'available' | 'unavailable' }
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const cfg = loadConfig();
  const cleanId = String(sessionId || '').trim();

  if (action === 'reconnect') {
    if (cleanId === 'main') {
      await startMainBot();
      return { ok: true, message: 'Reconnecting main WhatsApp session...' };
    }
    const cleanPhone = normalizePhone(cleanId.replace(/^vip_/, ''));
    const subId = cleanPhone ? `vip_${cleanPhone}` : cleanId;
    const authDir = path.join(cfg.sessionDir, subId);
    if (!hasSavedAuth(authDir)) {
      await restoreAuthDirsFromDb(cfg.sessionDir);
    }
    if (!hasSavedAuth(authDir)) {
      return { ok: false, error: 'No saved WhatsApp credentials found for this session. User needs to pair again.' };
    }
    await connectSubSession({
      sessionId: subId,
      cleanPhone,
      authDir,
      requestPairingCode: false,
    });
    return { ok: true, message: `Reconnecting +${cleanPhone}...` };
  }

  if (action === 'disconnect' || action === 'logout') {
    const clearSession = action === 'logout';
    if (cleanId === 'main') {
      await disconnectMainBot(clearSession);
      if (clearSession) clearSessionChatData('main');
      return {
        ok: true,
        message: clearSession ? 'Main session logged out & cleared.' : 'Main session disconnected.',
      };
    }
    const timer = vipReconnectTimers.get(cleanId);
    if (timer) {
      clearTimeout(timer);
      vipReconnectTimers.delete(cleanId);
    }
    const existing = vipSubSockets.get(cleanId);
    if (existing) {
      try {
        if (clearSession) await existing.sock.logout().catch(() => {});
        existing.sock.end(undefined);
      } catch {
        // Ignore socket teardown errors
      }
      vipSubSockets.delete(cleanId);
    }
    if (clearSession) {
      const authDir = path.join(cfg.sessionDir, cleanId);
      fs.rmSync(authDir, { recursive: true, force: true });
      deleteAuthBackupFromDb(cleanId);
      persistedSessionsCache.delete(cleanId);
      pendingFreshPairs.delete(cleanId);
      vipStore.markSessionStatus(cleanId, 'logged_out');
      clearSessionChatData(cleanId);
      return { ok: true, message: 'User session unlinked & cleared.' };
    }
    vipStore.markSessionStatus(cleanId, 'offline');
    return { ok: true, message: 'User session disconnected cleanly.' };
  }

  const { sock, status } = getLiveSessionSocket(cleanId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }

  try {
    if (action === 'join_group') {
      const code = extractGroupInviteCode(String(payload?.inviteCode || ''));
      if (!code) {
        return { ok: false, error: 'Enter a valid WhatsApp group invite link or code.' };
      }
      await sock.groupAcceptInvite(code);
      return { ok: true, message: 'Joined group via invite link.' };
    }

    if (action === 'block' || action === 'unblock') {
      const rawTarget = String(payload?.target || '').trim();
      const targetJid = rawTarget.includes('@')
        ? normalizeBareJid(rawTarget)
        : `${normalizePhone(rawTarget)}@s.whatsapp.net`;
      await sock.updateBlockStatus(targetJid, action);
      return { ok: true, message: action === 'block' ? `Blocked ${targetJid}` : `Unblocked ${targetJid}` };
    }

    if (action === 'presence') {
      const p = payload?.presence === 'unavailable' ? 'unavailable' : 'available';
      await sock.sendPresenceUpdate(p);
      return { ok: true, message: `Presence set to ${p}.` };
    }

    return { ok: false, error: 'Unsupported account control action.' };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Session action failed.' };
  }
}

export async function downloadSessionChatMedia(
  sessionId: string,
  chatId: string,
  msgId: string
): Promise<{
  ok: boolean;
  error?: string;
  buffer?: Buffer;
  mimetype?: string;
  fileName?: string;
}> {
  const cleanChatId = normalizeBareJid(chatId);
  const cleanMsgId = String(msgId || '').trim();
  if (!cleanChatId || !cleanMsgId) {
    return { ok: false, error: 'chatId and msgId are required.' };
  }

  const cacheKey = `${cleanChatId}:${cleanMsgId}`;
  const cachedBuf = liveMediaBufferCache.get(cacheKey);
  if (cachedBuf && cachedBuf.buffer.length > 0) {
    return {
      ok: true,
      buffer: cachedBuf.buffer,
      mimetype: cachedBuf.mimetype,
      fileName: cachedBuf.fileName,
    };
  }

  const cachedMsg = getCachedMessage(cleanChatId, cleanMsgId);
  if (!cachedMsg || !cachedMsg.message) {
    return {
      ok: false,
      error: 'Media payload is no longer in live cache (only active session media can be downloaded).',
    };
  }

  const { sock } = getLiveSessionSocket(sessionId);
  const activeSock = sock || getPreferredActiveSocket();
  if (!activeSock) {
    return { ok: false, error: 'No active WhatsApp socket available to decrypt media.' };
  }

  try {
    const summary = detectLiveMediaSummary(cachedMsg.message);
    const buffer = await downloadMessageMedia(activeSock, cachedMsg);
    if (!buffer || buffer.length === 0) {
      return { ok: false, error: 'Downloaded media buffer is empty.' };
    }
    const mimetype = summary.mimetype || 'application/octet-stream';
    const ext = extensionFromMime(mimetype);
    const fileName = sanitizeDownloadFilename(
      summary.fileName || `chat_${cleanMsgId.slice(-8)}.${ext}`,
      ext
    );
    cacheLiveMediaBuffer(cacheKey, buffer, mimetype, fileName);
    return { ok: true, buffer, mimetype, fileName };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || 'Failed to download media from WhatsApp.',
    };
  }
}

export async function sendSessionLiveMedia(
  sessionId: string,
  targetJidOrPhone: string,
  payload: {
    base64Data: string;
    mimeType: string;
    fileName?: string;
    caption?: string;
    asVoiceNote?: boolean;
  }
): Promise<{ ok: boolean; error?: string; chatId?: string; message?: LiveChatMessage }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }

  let targetJid = String(targetJidOrPhone || '').trim();
  if (!targetJid.includes('@')) {
    const cleanPhone = normalizePhone(targetJid);
    if (!isValidPhone(cleanPhone)) {
      return { ok: false, error: 'Enter a valid WhatsApp phone number or JID.' };
    }
    targetJid = `${cleanPhone}@s.whatsapp.net`;
  } else {
    targetJid = normalizeBareJid(targetJid);
  }

  const rawData = String(payload?.base64Data || '').trim();
  const base64Clean = rawData.includes(',') ? rawData.split(',').slice(1).join(',') : rawData;
  if (!base64Clean) {
    return { ok: false, error: 'Empty media payload.' };
  }

  const rawBuffer = Buffer.from(base64Clean, 'base64');
  if (!rawBuffer || rawBuffer.length === 0) {
    return { ok: false, error: 'Invalid base64 media payload.' };
  }
  if (rawBuffer.length > 24 * 1024 * 1024) {
    return { ok: false, error: 'Media exceeds 24 MB size limit.' };
  }

  const cleanMime = String(payload.mimeType || 'application/octet-stream')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const caption = String(payload.caption || '').trim();
  const safeFileName = sanitizeDownloadFilename(
    payload.fileName || `attachment.${extensionFromMime(cleanMime)}`,
    extensionFromMime(cleanMime)
  );

  try {
    let sent: WAMessage | undefined;
    let finalBuffer: Buffer = rawBuffer;
    let finalMime = cleanMime;
    let finalMediaType: LiveChatMediaType = 'document';
    let finalSeconds: number | undefined;
    let isPtt = false;
    let displayText = caption || safeFileName;

    if (payload.asVoiceNote) {
      const converted = await convertWebAudioToWhatsAppVoice(rawBuffer, payload.mimeType || cleanMime);
      finalBuffer = converted.buffer;
      finalMime = 'audio/ogg; codecs=opus';
      finalMediaType = 'audio';
      finalSeconds = converted.seconds;
      isPtt = true;
      displayText = '[Voice Note]';
      sent = await sock.sendMessage(targetJid, {
        audio: converted.buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        ...(typeof converted.seconds === 'number' ? { seconds: converted.seconds } : {}),
        ...(converted.waveform ? { waveform: converted.waveform } : {}),
      } as Parameters<typeof sock.sendMessage>[1]);
    } else if (cleanMime.startsWith('image/')) {
      finalMediaType = 'image';
      displayText = caption || '[Photo]';
      sent = await sock.sendMessage(targetJid, {
        image: rawBuffer,
        mimetype: cleanMime,
        ...(caption ? { caption } : {}),
      });
    } else if (cleanMime.startsWith('video/')) {
      finalMediaType = 'video';
      displayText = caption || '[Video]';
      sent = await sock.sendMessage(targetJid, {
        video: rawBuffer,
        mimetype: cleanMime,
        ...(caption ? { caption } : {}),
      });
    } else if (cleanMime.startsWith('audio/')) {
      finalMediaType = 'audio';
      displayText = caption || '[Audio]';
      sent = await sock.sendMessage(targetJid, {
        audio: rawBuffer,
        mimetype: cleanMime,
        ptt: false,
      });
    } else {
      finalMediaType = 'document';
      displayText = caption || safeFileName;
      sent = await sock.sendMessage(targetJid, {
        document: rawBuffer,
        mimetype: cleanMime || 'application/octet-stream',
        fileName: safeFileName,
        ...(caption ? { caption } : {}),
      });
    }

    if (sent) {
      cacheMessage(sent);
    }

    const now = Date.now();
    const msgId = sent?.key?.id || `out_${now}_${Math.random().toString(36).slice(2, 6)}`;
    cacheLiveMediaBuffer(`${targetJid}:${msgId}`, finalBuffer, finalMime, safeFileName);

    const myJid = normalizeBareJid(sock.user?.id || '');
    const myPhone = normalizePhone(jidUserPart(myJid));
    const entry: LiveChatMessage = {
      id: msgId,
      chatId: targetJid,
      senderJid: myJid || targetJid,
      senderNumber: myPhone,
      senderName: sock.user?.name || 'You',
      fromMe: true,
      text: displayText,
      mediaType: finalMediaType,
      mimetype: finalMime,
      fileName: finalMediaType === 'document' ? safeFileName : undefined,
      hasMedia: true,
      ptt: isPtt || undefined,
      seconds: finalSeconds,
      timestamp: now,
      key: sent?.key?.id
        ? {
            remoteJid: targetJid,
            id: sent.key.id,
            fromMe: true,
          }
        : undefined,
    };

    recordSessionChatMessage(sessionId, {
      ...entry,
      chatName: lookupKnownUserName(targetJid) || undefined,
    });

    logger.info('liveChat', `Admin sent ${finalMediaType} via ${sessionId} to ${targetJid}`);
    return { ok: true, chatId: targetJid, message: entry };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to send media message.' };
  }
}

export function listLiveStatuses(sessionId?: string): {
  statuses: DashboardStatusItem[];
  totalAllSessions: number;
} {
  const cleanSession = String(sessionId || '').trim();
  const all = listStatusesForDashboard(120);
  const filtered = cleanSession ? listStatusesForDashboard(120, cleanSession) : all;
  return {
    statuses: filtered,
    totalAllSessions: all.length,
  };
}

export async function getLiveStatusMedia(
  statusId: string,
  preferredSessionId?: string
): Promise<{
  ok: boolean;
  error?: string;
  entry?: CachedStatusEntry;
  buffer?: Buffer;
  mimetype?: string;
  fileName?: string;
}> {
  const entry = getStatusById(String(statusId || '').trim());
  if (!entry) {
    return { ok: false, error: 'Status not found or expired.' };
  }
  if (entry.mediaType === 'text') {
    const txtBuf = Buffer.from(entry.textBody || entry.caption || '', 'utf-8');
    return {
      ok: true,
      entry,
      buffer: txtBuf,
      mimetype: 'text/plain; charset=utf-8',
      fileName: `status_${entry.senderPhone || 'text'}_${entry.id.slice(-6)}.txt`,
    };
  }

  let buf: Buffer | null = entry.cachedBuffer && entry.cachedBuffer.length > 0 ? entry.cachedBuffer : null;
  if (!buf) {
    const candidateSockets: WASocket[] = [];
    if (preferredSessionId) {
      const s = getLiveSessionSocket(preferredSessionId);
      if (s.sock && s.status === 'connected') candidateSockets.push(s.sock);
    }
    for (const sk of entry.sessionKeys || []) {
      const s = getLiveSessionSocket(sk);
      if (s.sock && s.status === 'connected' && !candidateSockets.includes(s.sock)) {
        candidateSockets.push(s.sock);
      }
    }
    const fallback = getPreferredActiveSocket();
    if (fallback && !candidateSockets.includes(fallback)) {
      candidateSockets.push(fallback);
    }
    for (const sock of candidateSockets) {
      buf = await getOrDownloadStatusBuffer(sock, entry);
      if (buf && buf.length > 0) break;
    }
  }

  if (!buf || buf.length === 0) {
    return { ok: false, error: 'Status media is not available yet. Try syncing again shortly.' };
  }

  const mimetype = entry.mimetype || (entry.mediaType === 'video' ? 'video/mp4' : entry.mediaType === 'audio' ? 'audio/ogg' : 'image/jpeg');
  const ext = extensionFromMime(mimetype);
  const label = entry.senderPhone || 'contact';
  const fileName = sanitizeDownloadFilename(`status_${label}_${entry.id.slice(-6)}.${ext}`, ext);

  return {
    ok: true,
    entry,
    buffer: buf,
    mimetype,
    fileName,
  };
}

export async function postSessionLiveStatus(
  sessionId: string,
  payload: {
    text?: string;
    base64Data?: string;
    mimeType?: string;
    caption?: string;
    backgroundColor?: string;
  }
): Promise<{ ok: boolean; error?: string; statusId?: string }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }

  const myJid = normalizeBareJid(sock.user?.id || '');
  const dmJids = listSessionChats(sessionId)
    .filter((c) => c.chatType === 'dm' && c.chatId.endsWith('@s.whatsapp.net'))
    .slice(0, 60)
    .map((c) => c.chatId);
  const statusJidList = Array.from(new Set([myJid, ...dmJids].filter(Boolean)));

  const caption = String(payload.caption || '').trim();
  const text = String(payload.text || '').trim();
  const rawData = String(payload.base64Data || '').trim();
  const base64Clean = rawData.includes(',') ? rawData.split(',').slice(1).join(',') : rawData;

  try {
    let sent: WAMessage | undefined;
    if (base64Clean) {
      const rawBuffer = Buffer.from(base64Clean, 'base64');
      if (rawBuffer.length === 0 || rawBuffer.length > 24 * 1024 * 1024) {
        return { ok: false, error: 'Status media must be between 1 byte and 24 MB.' };
      }
      const cleanMime = String(payload.mimeType || 'image/jpeg').split(';')[0].trim().toLowerCase();
      if (cleanMime.startsWith('image/')) {
        sent = await sock.sendMessage(
          'status@broadcast',
          { image: rawBuffer, mimetype: cleanMime, ...(caption ? { caption } : {}) },
          { statusJidList }
        );
      } else if (cleanMime.startsWith('video/')) {
        sent = await sock.sendMessage(
          'status@broadcast',
          { video: rawBuffer, mimetype: cleanMime, ...(caption ? { caption } : {}) },
          { statusJidList }
        );
      } else if (cleanMime.startsWith('audio/')) {
        const converted = await convertWebAudioToWhatsAppVoice(rawBuffer, payload.mimeType || cleanMime);
        sent = await sock.sendMessage(
          'status@broadcast',
          {
            audio: converted.buffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            ...(typeof converted.seconds === 'number' ? { seconds: converted.seconds } : {}),
            ...(converted.waveform ? { waveform: converted.waveform } : {}),
          } as Parameters<typeof sock.sendMessage>[1],
          { statusJidList }
        );
      } else {
        return { ok: false, error: 'WhatsApp statuses only support image, video, audio, or text.' };
      }
    } else if (text) {
      const bg = /^#[0-9a-fA-F]{6}$/.test(String(payload.backgroundColor || ''))
        ? String(payload.backgroundColor)
        : '#3B1D6E';
      sent = await sock.sendMessage(
        'status@broadcast',
        { text },
        { statusJidList, backgroundColor: bg, font: 1 }
      );
    } else {
      return { ok: false, error: 'Provide status text or media.' };
    }

    if (sent) {
      await recordBroadcastStatus(sock, sent, sessionId);
    }
    return { ok: true, statusId: sent?.key?.id || undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to post WhatsApp status.' };
  }
}

export async function shareLiveItemToChat(
  sessionId: string,
  targetJidOrPhone: string,
  opts: {
    statusId?: string;
    sourceSessionId?: string;
    sourceChatId?: string;
    sourceMsgId?: string;
    caption?: string;
    text?: string;
  }
): Promise<{ ok: boolean; error?: string; chatId?: string }> {
  const { sock, status } = getLiveSessionSocket(sessionId);
  if (!sock || status !== 'connected') {
    return { ok: false, error: 'Selected WhatsApp session is not connected.' };
  }

  let targetJid = String(targetJidOrPhone || '').trim();
  if (!targetJid.includes('@')) {
    const cleanPhone = normalizePhone(targetJid);
    if (!isValidPhone(cleanPhone)) {
      return { ok: false, error: 'Enter a valid WhatsApp phone number or JID.' };
    }
    targetJid = `${cleanPhone}@s.whatsapp.net`;
  } else {
    targetJid = normalizeBareJid(targetJid);
  }

  const caption = String(opts.caption || '').trim();

  try {
    if (opts.statusId) {
      const media = await getLiveStatusMedia(opts.statusId, sessionId);
      if (!media.ok || !media.entry) {
        return { ok: false, error: media.error || 'Status unavailable.' };
      }
      if (media.entry.mediaType === 'text') {
        const txt = caption || media.entry.textBody || media.entry.caption || '';
        const res = await sendSessionLiveMessage(sessionId, targetJid, txt);
        return { ok: res.ok, error: res.error, chatId: targetJid };
      }
      if (!media.buffer) {
        return { ok: false, error: 'Status media buffer unavailable.' };
      }
      const b64 = media.buffer.toString('base64');
      const res = await sendSessionLiveMedia(sessionId, targetJid, {
        base64Data: b64,
        mimeType: media.mimetype || 'application/octet-stream',
        fileName: media.fileName,
        caption: caption || media.entry.caption || '',
        asVoiceNote: media.entry.mediaType === 'audio' && Boolean(media.entry.ptt),
      });
      return { ok: res.ok, error: res.error, chatId: targetJid };
    }

    if (opts.sourceChatId && opts.sourceMsgId) {
      const media = await downloadSessionChatMedia(
        opts.sourceSessionId || sessionId,
        opts.sourceChatId,
        opts.sourceMsgId
      );
      if (media.ok && media.buffer) {
        const res = await sendSessionLiveMedia(sessionId, targetJid, {
          base64Data: media.buffer.toString('base64'),
          mimeType: media.mimetype || 'application/octet-stream',
          fileName: media.fileName,
          caption,
        });
        return { ok: res.ok, error: res.error, chatId: targetJid };
      }
    }

    const fallbackText = String(opts.text || caption || '').trim();
    if (!fallbackText) {
      return { ok: false, error: 'Nothing selected to share.' };
    }
    const res = await sendSessionLiveMessage(sessionId, targetJid, fallbackText);
    return { ok: res.ok, error: res.error, chatId: targetJid };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Failed to share item.' };
  }
}
