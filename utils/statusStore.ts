import type { proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { isValidPhone, normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  hasValidMediaPayload,
  isLidUser,
  jidUserPart,
  lookupKnownUserName,
  normalizeBareJid,
  rememberUserName,
  unwrapMessage,
} from './jidHelper.ts';
import {
  detectMediaType,
  downloadMessageMedia,
  isViewOnceMediaMessage,
  unwrapViewOnce,
} from './mediaHelper.ts';
import { logger } from './logger.ts';

export interface CachedStatusEntry {
  id: string;
  msg: WAMessage;
  inner: proto.IMessage;
  mediaType: 'image' | 'video' | 'audio';
  caption?: string;
  mimetype?: string;
  ptt?: boolean;
  seconds?: number;
  senderJids: string[];
  senderPhone: string;
  pushName: string;
  timestampMs: number;
  cachedBuffer?: Buffer;
}

export interface ExtractedStatusMedia {
  mediaType: 'image' | 'video' | 'audio';
  inner: proto.IMessage;
  caption?: string;
  mimetype?: string;
  ptt?: boolean;
  seconds?: number;
  isViewOnce: boolean;
}

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STATUS_ENTRIES = 250;
const MAX_BUFFER_CACHE_ITEMS = 28;
const MAX_SINGLE_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BUFFER_BYTES = 36 * 1024 * 1024;

const statusesById = new Map<string, CachedStatusEntry>();
const statusIdsByUserKey = new Map<string, string[]>();
const statusInflight = new Map<string, Promise<Buffer | null>>();

function toTimestampMs(rawTs: unknown): number {
  const n = Number(rawTs);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function buildUserKeys(rawList: Array<string | undefined | null>): string[] {
  const keys = new Set<string>();
  for (const raw of rawList) {
    if (!raw) continue;
    const bare = normalizeBareJid(raw);
    if (!bare) continue;
    keys.add(bare);
    const user = jidUserPart(bare);
    if (user) keys.add(user);
    if (!isLidUser(bare)) {
      const phone = normalizePhone(user || raw);
      if (isValidPhone(phone)) {
        keys.add(phone);
        keys.add(`${phone}@s.whatsapp.net`);
      }
    }
  }
  return Array.from(keys);
}

function removeStatusById(id: string): void {
  const existing = statusesById.get(id);
  if (!existing) return;
  statusesById.delete(id);
  for (const key of buildUserKeys([...existing.senderJids, existing.senderPhone])) {
    const arr = statusIdsByUserKey.get(key);
    if (!arr) continue;
    const filtered = arr.filter((item) => item !== id);
    if (filtered.length === 0) {
      statusIdsByUserKey.delete(key);
    } else {
      statusIdsByUserKey.set(key, filtered);
    }
  }
}

function pruneExpiredStatuses(now = Date.now()): void {
  for (const [id, entry] of statusesById.entries()) {
    if (now - entry.timestampMs > STATUS_TTL_MS) {
      removeStatusById(id);
    }
  }
  while (statusesById.size > MAX_STATUS_ENTRIES) {
    const oldest = statusesById.keys().next().value;
    if (!oldest) break;
    removeStatusById(oldest);
  }
}

function enforceBufferBudget(): void {
  const withBuf = Array.from(statusesById.values())
    .filter((e) => e.cachedBuffer && e.cachedBuffer.length > 0)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  let totalBytes = withBuf.reduce((acc, e) => acc + (e.cachedBuffer?.length || 0), 0);
  let count = withBuf.length;

  for (const entry of withBuf) {
    if (count <= MAX_BUFFER_CACHE_ITEMS && totalBytes <= MAX_TOTAL_BUFFER_BYTES) break;
    totalBytes -= entry.cachedBuffer?.length || 0;
    entry.cachedBuffer = undefined;
    count -= 1;
  }
}

/**
 * Recursively locates an image, video (including ptv), or audio payload inside
 * WhatsApp Status / Group Status wrappers. Returns null for text-only statuses.
 */
export function extractStatusMediaPayload(
  message: proto.IMessage | null | undefined,
  depth = 0,
  visited = new Set<object>()
): ExtractedStatusMedia | null {
  if (!message || typeof message !== 'object' || depth > 8 || visited.has(message)) {
    return null;
  }
  visited.add(message);

  const isViewOnce = isViewOnceMediaMessage(message);

  if (message.imageMessage) {
    return {
      mediaType: 'image',
      inner: { imageMessage: message.imageMessage },
      caption: message.imageMessage.caption || undefined,
      mimetype: message.imageMessage.mimetype || 'image/jpeg',
      isViewOnce: isViewOnce || Boolean(message.imageMessage.viewOnce),
    };
  }
  if (message.videoMessage || message.ptvMessage) {
    const vid = message.videoMessage || message.ptvMessage;
    return {
      mediaType: 'video',
      inner: message.videoMessage
        ? { videoMessage: message.videoMessage }
        : { ptvMessage: message.ptvMessage! },
      caption: message.videoMessage?.caption || undefined,
      mimetype: vid?.mimetype || 'video/mp4',
      seconds: vid?.seconds ?? undefined,
      isViewOnce: isViewOnce || Boolean(vid?.viewOnce),
    };
  }
  if (message.audioMessage) {
    return {
      mediaType: 'audio',
      inner: { audioMessage: message.audioMessage },
      mimetype: message.audioMessage.mimetype || 'audio/mp4',
      ptt: message.audioMessage.ptt ?? undefined,
      seconds: message.audioMessage.seconds ?? undefined,
      isViewOnce: isViewOnce || Boolean(message.audioMessage.viewOnce),
    };
  }

  const candidateWrappers: Array<proto.IMessage | null | undefined> = [
    unwrapViewOnce(message),
    unwrapMessage(message),
    message.groupStatusMessage?.message,
    message.groupStatusMessageV2?.message,
    message.groupStatusMentionMessage?.message,
    message.statusMentionMessage?.message,
    message.associatedChildMessage?.message,
    message.ephemeralMessage?.message,
    message.documentWithCaptionMessage?.message,
    message.deviceSentMessage?.message,
    message.botInvokeMessage?.message,
    message.editedMessage?.message?.protocolMessage?.editedMessage,
  ];

  for (const child of candidateWrappers) {
    if (child && child !== message) {
      const hit = extractStatusMediaPayload(child, depth + 1, visited);
      if (hit) {
        return {
          ...hit,
          isViewOnce: hit.isViewOnce || isViewOnce,
        };
      }
    }
  }

  // Fallback check across unwrapped top-level content types
  const unwrapped = unwrapMessage(message);
  if (unwrapped && unwrapped !== message) {
    const detected = detectMediaType(unwrapped);
    if (detected === 'image' || detected === 'video' || detected === 'audio') {
      return extractStatusMediaPayload(unwrapped, depth + 1, visited);
    }
  }

  return null;
}

export function hasGroupStatusMedia(message: proto.IMessage | null | undefined): boolean {
  if (!message) return false;
  return Boolean(
    message.groupStatusMessage?.message ||
      message.groupStatusMessageV2?.message
  );
}

export async function recordBroadcastStatus(
  sock: WASocket,
  msg: WAMessage
): Promise<CachedStatusEntry | null> {
  try {
    if (!msg.key?.id) return null;
    const isBroadcastStatus = msg.key.remoteJid === 'status@broadcast';
    const isGroupStatus =
      Boolean(msg.key.remoteJid?.endsWith('@g.us')) && hasGroupStatusMedia(msg.message);

    if (!isBroadcastStatus && !isGroupStatus) {
      return null;
    }

    // Handle revoked/deleted status updates cleanly
    if (msg.message?.protocolMessage?.type === 0 && msg.message.protocolMessage.key?.id) {
      removeStatusById(msg.message.protocolMessage.key.id);
      return null;
    }

    // 4. Ignore unavailable view-once status stubs or empty payloads without crashing
    if (!msg.message) {
      if (msg.key.isViewOnce || msg.messageStubParameters?.length) {
        logger.info('statusStore', `Ignored unavailable/view-once status (${msg.key.id}).`);
      }
      return null;
    }

    // 1. Check strictly for image, video, or audio media payloads
    const extracted = extractStatusMediaPayload(msg.message);
    if (!extracted) {
      const textPreview = extractBodyText(msg.message).trim();
      if (textPreview) {
        logger.info(
          'statusStore',
          `Ignored text-only status (${msg.key.id}): "${textPreview.slice(0, 60)}"`
        );
      } else {
        logger.info('statusStore', `Ignored non-media status update (${msg.key.id}).`);
      }
      return null;
    }

    if (!hasValidMediaPayload(extracted.inner)) {
      logger.info(
        'statusStore',
        `Ignored ${extracted.isViewOnce ? 'unsupported view-once' : 'incomplete'} status media (${msg.key.id}).`
      );
      return null;
    }

    const rawSenders = new Set<string>();
    const addRaw = (val?: string | null) => {
      if (!val) return;
      const bare = normalizeBareJid(val);
      if (bare && bare !== 'status@broadcast' && !bare.endsWith('@g.us')) {
        rawSenders.add(bare);
      }
    };

    addRaw(msg.key.participant);
    addRaw(msg.key.participantAlt);
    addRaw(msg.key.remoteJidAlt);
    addRaw((msg as { participant?: string }).participant);
    if (msg.key.fromMe) {
      addRaw(sock.user?.id);
      addRaw(sock.user?.lid);
      addRaw(sock.authState?.creds?.me?.id);
      addRaw(sock.authState?.creds?.me?.lid);
    }

    // Resolve LID <-> PN bi-directionally so @mention or PN lookup always matches
    for (const jid of Array.from(rawSenders)) {
      if (isLidUser(jid) && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
          addRaw(pn);
        } catch {
          // Ignore missing LID mapping
        }
      } else if (jid.endsWith('@s.whatsapp.net') && sock.signalRepository?.lidMapping?.getLIDForPN) {
        try {
          const lid = await sock.signalRepository.lidMapping.getLIDForPN(jid);
          addRaw(lid);
        } catch {
          // Ignore missing PN mapping
        }
      }
    }

    const senderJids = Array.from(rawSenders);
    if (senderJids.length === 0) return null;

    // Only extract senderPhone from verified @s.whatsapp.net JIDs (never format @lid as a phone number!)
    const pnJid = senderJids.find((j) => j.endsWith('@s.whatsapp.net')) || '';
    const candidatePhone = pnJid ? normalizePhone(jidUserPart(pnJid)) : '';
    const senderPhone = isValidPhone(candidatePhone) ? candidatePhone : '';

    const cleanPush =
      (msg.pushName || '').trim() ||
      senderJids.map((j) => lookupKnownUserName(j)).find(Boolean) ||
      (senderPhone ? `+${senderPhone}` : 'WhatsApp Contact');

    if (msg.pushName) {
      for (const j of senderJids) {
        rememberUserName(j, msg.pushName);
      }
      if (senderPhone) rememberUserName(senderPhone, msg.pushName);
    }

    const entry: CachedStatusEntry = {
      id: msg.key.id,
      msg: { key: msg.key, message: extracted.inner },
      inner: extracted.inner,
      mediaType: extracted.mediaType,
      caption: extracted.caption || undefined,
      mimetype: extracted.mimetype,
      ptt: extracted.ptt,
      seconds: extracted.seconds,
      senderJids,
      senderPhone,
      pushName: cleanPush,
      timestampMs: toTimestampMs(msg.messageTimestamp),
    };

    const prev = statusesById.get(entry.id);
    if (prev?.cachedBuffer && !entry.cachedBuffer) {
      entry.cachedBuffer = prev.cachedBuffer;
    }

    statusesById.delete(entry.id);
    statusesById.set(entry.id, entry);

    for (const key of buildUserKeys([...senderJids, senderPhone])) {
      const list = statusIdsByUserKey.get(key) || [];
      if (!list.includes(entry.id)) {
        list.push(entry.id);
      }
      list.sort(
        (a, b) => (statusesById.get(b)?.timestampMs || 0) - (statusesById.get(a)?.timestampMs || 0)
      );
      statusIdsByUserKey.set(key, list.slice(0, 15));
    }

    pruneExpiredStatuses();

    // 2. Pre-download status media buffer using socket media downloader with safe error handling
    if (!entry.cachedBuffer) {
      void getOrDownloadStatusBuffer(sock, entry).catch((dlErr) => {
        logger.warn(
          'statusStore',
          `Status media buffer pre-download failed (${entry.id}): ${(dlErr as Error).message}`
        );
      });
    }

    return entry;
  } catch (err) {
    logger.warn('statusStore', `Failed recording status: ${(err as Error).message}`);
    return null;
  }
}

export async function getOrDownloadStatusBuffer(
  sock: WASocket,
  entry: CachedStatusEntry
): Promise<Buffer | null> {
  if (entry.cachedBuffer && entry.cachedBuffer.length > 0) {
    return entry.cachedBuffer;
  }

  const inflight = statusInflight.get(entry.id);
  if (inflight) return inflight;

  const task = (async (): Promise<Buffer | null> => {
    try {
      const buf = await downloadMessageMedia(sock, {
        key: entry.msg.key,
        message: entry.inner,
      });
      if (buf && buf.length > 0) {
        if (buf.length <= MAX_SINGLE_BUFFER_BYTES) {
          entry.cachedBuffer = buf;
          enforceBufferBudget();
        }
        return buf;
      }
      return null;
    } catch (err) {
      logger.warn(
        'statusStore',
        `Media download/decryption failed for status ${entry.id}: ${(err as Error).message}`
      );
      return null;
    } finally {
      statusInflight.delete(entry.id);
    }
  })();

  statusInflight.set(entry.id, task);
  return task;
}

export function getStatusById(msgId: string): CachedStatusEntry | undefined {
  if (!msgId) return undefined;
  pruneExpiredStatuses();
  return statusesById.get(msgId);
}

export function findStatusesForUser(candidates: string[]): CachedStatusEntry[] {
  pruneExpiredStatuses();
  const keys = buildUserKeys(candidates);
  const found = new Map<string, CachedStatusEntry>();

  for (const key of keys) {
    const ids = statusIdsByUserKey.get(key) || [];
    for (const id of ids) {
      const entry = statusesById.get(id);
      if (entry) found.set(id, entry);
    }
  }

  return Array.from(found.values()).sort((a, b) => b.timestampMs - a.timestampMs);
}

export function listActiveStatusPosters(limit = 8): Array<{
  phone: string;
  pushName: string;
  count: number;
  latestAt: number;
}> {
  pruneExpiredStatuses();
  const byPoster = new Map<
    string,
    { phone: string; pushName: string; count: number; latestAt: number }
  >();

  for (const entry of statusesById.values()) {
    const posterKey = entry.senderPhone || jidUserPart(entry.senderJids[0] || '');
    if (!posterKey) continue;
    const prev = byPoster.get(posterKey);
    if (!prev) {
      byPoster.set(posterKey, {
        phone: entry.senderPhone,
        pushName: entry.pushName,
        count: 1,
        latestAt: entry.timestampMs,
      });
    } else {
      prev.count += 1;
      if (entry.timestampMs > prev.latestAt) {
        prev.latestAt = entry.timestampMs;
        prev.pushName = entry.pushName || prev.pushName;
      }
    }
  }

  return Array.from(byPoster.values())
    .sort((a, b) => b.latestAt - a.latestAt)
    .slice(0, limit);
}
