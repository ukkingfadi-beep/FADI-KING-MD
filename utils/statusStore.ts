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
import { detectMediaType, downloadMessageMedia, unwrapViewOnce } from './mediaHelper.ts';
import { logger } from './logger.ts';

export interface CachedStatusEntry {
  id: string;
  msg: WAMessage;
  inner: proto.IMessage;
  mediaType: 'image' | 'video' | 'audio' | 'text';
  text?: string;
  mimetype?: string;
  senderJids: string[];
  senderPhone: string;
  pushName: string;
  timestampMs: number;
  cachedBuffer?: Buffer;
}

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STATUS_ENTRIES = 250;
const MAX_BUFFER_CACHE_ITEMS = 24;
const MAX_SINGLE_BUFFER_BYTES = 14 * 1024 * 1024;
const MAX_TOTAL_BUFFER_BYTES = 28 * 1024 * 1024;

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
    if (bare) keys.add(bare);
    const user = jidUserPart(bare || raw);
    if (user) keys.add(user);
    const phone = normalizePhone(user || raw);
    if (isValidPhone(phone)) {
      keys.add(phone);
      keys.add(`${phone}@s.whatsapp.net`);
    }
  }
  return Array.from(keys);
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

export async function recordBroadcastStatus(
  sock: WASocket,
  msg: WAMessage
): Promise<CachedStatusEntry | null> {
  try {
    if (!msg.key || msg.key.remoteJid !== 'status@broadcast' || !msg.key.id || !msg.message) {
      return null;
    }

    // Handle revoked/deleted status updates cleanly
    if (msg.message.protocolMessage?.type === 0 && msg.message.protocolMessage.key?.id) {
      removeStatusById(msg.message.protocolMessage.key.id);
      return null;
    }

    const unwrapped = unwrapViewOnce(msg.message) || unwrapMessage(msg.message) || msg.message;
    const detected = detectMediaType(unwrapped);
    const bodyText = extractBodyText(unwrapped).trim();

    let mediaType: CachedStatusEntry['mediaType'];
    if (detected === 'image' || detected === 'video' || detected === 'audio') {
      mediaType = detected;
    } else if (bodyText) {
      mediaType = 'text';
    } else {
      return null;
    }

    const rawSenders = new Set<string>();
    const addRaw = (val?: string | null) => {
      if (!val) return;
      const bare = normalizeBareJid(val);
      if (bare && bare !== 'status@broadcast') rawSenders.add(bare);
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

    // Resolve LID <-> PN bi-directionally so @mention or PN always finds the status
    const currentSnapshot = Array.from(rawSenders);
    for (const jid of currentSnapshot) {
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

    const pnJid = senderJids.find((j) => j.endsWith('@s.whatsapp.net')) || senderJids[0];
    const senderPhone = normalizePhone(jidUserPart(pnJid));

    const cleanPush =
      (msg.pushName || '').trim() ||
      senderJids.map((j) => lookupKnownUserName(j)).find(Boolean) ||
      (senderPhone ? `+${senderPhone}` : jidUserPart(pnJid));

    if (msg.pushName) {
      for (const j of senderJids) {
        rememberUserName(j, msg.pushName);
      }
      if (senderPhone) rememberUserName(senderPhone, msg.pushName);
    }

    const caption =
      mediaType === 'image'
        ? unwrapped.imageMessage?.caption || bodyText
        : mediaType === 'video'
          ? unwrapped.videoMessage?.caption || bodyText
          : bodyText;

    const mimetype =
      unwrapped.imageMessage?.mimetype ||
      unwrapped.videoMessage?.mimetype ||
      unwrapped.audioMessage?.mimetype ||
      undefined;

    const entry: CachedStatusEntry = {
      id: msg.key.id,
      msg,
      inner: unwrapped,
      mediaType,
      text: caption || undefined,
      mimetype: mimetype || undefined,
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
      // Keep newest IDs bounded per key
      list.sort((a, b) => (statusesById.get(b)?.timestampMs || 0) - (statusesById.get(a)?.timestampMs || 0));
      statusIdsByUserKey.set(key, list.slice(0, 15));
    }

    pruneExpiredStatuses();

    // Warm small/medium media status buffer in background so expired CDN URLs don't break .savestatus
    if (mediaType !== 'text' && !entry.cachedBuffer && hasValidMediaPayload(unwrapped)) {
      void getOrDownloadStatusBuffer(sock, entry).catch(() => {});
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
  if (entry.mediaType === 'text') return null;
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
    } catch {
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
        phone: entry.senderPhone || posterKey,
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
