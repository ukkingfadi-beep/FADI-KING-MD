import type { proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { isValidPhone, normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  extractContextInfo,
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
  mediaType: 'image' | 'video' | 'audio' | 'text';
  caption?: string;
  textBody?: string;
  backgroundArgb?: number;
  mimetype?: string;
  ptt?: boolean;
  seconds?: number;
  senderJids: string[];
  senderPhone: string;
  pushName: string;
  timestampMs: number;
  sessionKeys?: string[];
  cachedBuffer?: Buffer;
}

export interface DashboardStatusItem {
  id: string;
  mediaType: 'image' | 'video' | 'audio' | 'text';
  caption?: string;
  textBody?: string;
  backgroundArgb?: number;
  mimetype?: string;
  ptt?: boolean;
  seconds?: number;
  senderPhone: string;
  senderJid: string;
  pushName: string;
  timestampMs: number;
  hasBuffer: boolean;
  sessionKeys: string[];
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

export interface StatusMentionRecord {
  mentionMsgId: string;
  chatId: string;
  referencedStatusIds: string[];
  senderJids: string[];
  senderPhone: string;
  pushName: string;
  timestampMs: number;
}

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STATUS_ENTRIES = 250;
const MAX_BUFFER_CACHE_ITEMS = 28;
const MAX_SINGLE_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BUFFER_BYTES = 36 * 1024 * 1024;

const statusesById = new Map<string, CachedStatusEntry>();
const statusIdsByUserKey = new Map<string, string[]>();
const statusIdsByGroupKey = new Map<string, string[]>();
const statusIdAliases = new Map<string, string>();
const mentionRecordsByMsgId = new Map<string, StatusMentionRecord>();
const mentionIdsByGroupKey = new Map<string, string[]>();
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
  for (const [groupKey, arr] of statusIdsByGroupKey.entries()) {
    const filtered = arr.filter((item) => item !== id);
    if (filtered.length === 0) {
      statusIdsByGroupKey.delete(groupKey);
    } else if (filtered.length !== arr.length) {
      statusIdsByGroupKey.set(groupKey, filtered);
    }
  }
  for (const [alias, target] of statusIdAliases.entries()) {
    if (target === id) statusIdAliases.delete(alias);
  }
}

function pruneExpiredStatuses(now = Date.now()): void {
  for (const [id, entry] of statusesById.entries()) {
    if (now - entry.timestampMs > STATUS_TTL_MS) {
      removeStatusById(id);
    }
  }
  for (const [mId, rec] of mentionRecordsByMsgId.entries()) {
    if (now - rec.timestampMs > STATUS_TTL_MS) {
      mentionRecordsByMsgId.delete(mId);
      const arr = mentionIdsByGroupKey.get(rec.chatId);
      if (arr) {
        const filtered = arr.filter((x) => x !== mId);
        if (filtered.length === 0) mentionIdsByGroupKey.delete(rec.chatId);
        else mentionIdsByGroupKey.set(rec.chatId, filtered);
      }
    }
  }
  while (statusesById.size > MAX_STATUS_ENTRIES) {
    const oldest = statusesById.keys().next().value;
    if (!oldest) break;
    removeStatusById(oldest);
  }
  while (mentionRecordsByMsgId.size > MAX_STATUS_ENTRIES) {
    const oldest = mentionRecordsByMsgId.keys().next().value;
    if (!oldest) break;
    mentionRecordsByMsgId.delete(oldest);
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

  const msgCtx = extractContextInfo(message);
  const rawRecord = message as Record<string, unknown>;
  const rawCtxInfo = rawRecord.contextInfo as
    | (proto.IContextInfo & { statusMentionMessageInfo?: { quotedStatus?: proto.IMessage | null } | null })
    | undefined;
  const quotedStatusFromCtx =
    (msgCtx as { statusMentionMessageInfo?: { quotedStatus?: proto.IMessage | null } | null } | undefined)
      ?.statusMentionMessageInfo?.quotedStatus ||
    rawCtxInfo?.statusMentionMessageInfo?.quotedStatus ||
    (rawRecord.statusMentionMessageInfo as { quotedStatus?: proto.IMessage | null } | undefined)
      ?.quotedStatus;

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
    message.protocolMessage?.editedMessage,
    message.editedMessage?.message?.protocolMessage?.editedMessage,
    quotedStatusFromCtx,
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

export function extractReferencedStatusIds(
  message: proto.IMessage | null | undefined,
  depth = 0,
  visited = new Set<object>()
): string[] {
  if (!message || typeof message !== 'object' || depth > 6 || visited.has(message)) return [];
  visited.add(message);
  const ids = new Set<string>();

  if (message.protocolMessage?.key?.id) ids.add(String(message.protocolMessage.key.id));
  if (message.statusNotificationMessage?.originalMessageKey?.id) {
    ids.add(String(message.statusNotificationMessage.originalMessageKey.id));
  }
  if (message.statusNotificationMessage?.responseMessageKey?.id) {
    ids.add(String(message.statusNotificationMessage.responseMessageKey.id));
  }
  if (message.statusQuotedMessage?.originalStatusId?.id) {
    ids.add(String(message.statusQuotedMessage.originalStatusId.id));
  }

  const children: Array<proto.IMessage | null | undefined> = [
    message.groupStatusMessage?.message,
    message.groupStatusMessageV2?.message,
    message.groupStatusMentionMessage?.message,
    message.statusMentionMessage?.message,
    message.associatedChildMessage?.message,
    message.ephemeralMessage?.message,
    message.deviceSentMessage?.message,
    message.botInvokeMessage?.message,
    message.protocolMessage?.editedMessage,
  ];
  for (const child of children) {
    if (child) {
      for (const id of extractReferencedStatusIds(child, depth + 1, visited)) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids).filter(Boolean);
}

export function extractStatusMentionTargets(
  message: proto.IMessage | null | undefined,
  depth = 0,
  visited = new Set<object>()
): string[] {
  if (!message || typeof message !== 'object' || depth > 6 || visited.has(message)) return [];
  visited.add(message);
  const targets = new Set<string>();

  const collectFromCtx = (ctx?: proto.IContextInfo | null) => {
    if (!ctx) return;
    const extended = ctx as proto.IContextInfo & {
      statusMentions?: string[] | null;
      statusMentionSources?: string[] | null;
    };
    for (const j of [
      ...(extended.statusMentions || []),
      ...(extended.statusMentionSources || []),
      ...(extended.mentionedJid || []),
    ]) {
      const bare = normalizeBareJid(j);
      if (bare) targets.add(bare);
    }
  };

  collectFromCtx(extractContextInfo(message));
  collectFromCtx((message as { contextInfo?: proto.IContextInfo }).contextInfo);
  collectFromCtx(message.extendedTextMessage?.contextInfo);
  collectFromCtx(message.imageMessage?.contextInfo);
  collectFromCtx(message.videoMessage?.contextInfo);
  collectFromCtx(message.audioMessage?.contextInfo);

  const children: Array<proto.IMessage | null | undefined> = [
    message.groupStatusMessage?.message,
    message.groupStatusMessageV2?.message,
    message.groupStatusMentionMessage?.message,
    message.statusMentionMessage?.message,
    message.associatedChildMessage?.message,
    message.ephemeralMessage?.message,
    message.deviceSentMessage?.message,
  ];
  for (const child of children) {
    if (child) {
      for (const t of extractStatusMentionTargets(child, depth + 1, visited)) {
        targets.add(t);
      }
    }
  }
  return Array.from(targets);
}

export function isStatusMentionStubMessage(
  message: proto.IMessage | null | undefined,
  depth = 0
): boolean {
  if (!message || typeof message !== 'object' || depth > 6) return false;
  if (
    message.groupStatusMentionMessage?.message ||
    message.statusMentionMessage?.message ||
    message.statusNotificationMessage ||
    message.statusQuotedMessage ||
    message.protocolMessage?.type === 25
  ) {
    return true;
  }
  const ctx = extractContextInfo(message) as
    | (proto.IContextInfo & {
        statusMentionMessageInfo?: unknown;
        statusMentions?: unknown[];
      })
    | undefined;
  if (
    ctx?.statusMentionMessageInfo ||
    (Array.isArray(ctx?.statusMentions) && ctx.statusMentions.length > 0)
  ) {
    return true;
  }
  return Boolean(
    isStatusMentionStubMessage(message.ephemeralMessage?.message, depth + 1) ||
      isStatusMentionStubMessage(message.deviceSentMessage?.message, depth + 1) ||
      isStatusMentionStubMessage(message.associatedChildMessage?.message, depth + 1)
  );
}

export function hasGroupStatusMedia(
  message: proto.IMessage | null | undefined,
  depth = 0
): boolean {
  if (!message || typeof message !== 'object' || depth > 6) return false;
  if (
    message.groupStatusMessage?.message ||
    message.groupStatusMessageV2?.message ||
    message.groupStatusMentionMessage?.message ||
    message.statusMentionMessage?.message ||
    message.statusNotificationMessage ||
    message.statusQuotedMessage ||
    message.protocolMessage?.type === 25
  ) {
    return true;
  }
  const ctx = extractContextInfo(message) as
    | (proto.IContextInfo & { statusMentionMessageInfo?: { quotedStatus?: unknown } | null })
    | undefined;
  if (ctx?.statusMentionMessageInfo?.quotedStatus) return true;
  return Boolean(
    hasGroupStatusMedia(message.ephemeralMessage?.message, depth + 1) ||
      hasGroupStatusMedia(message.deviceSentMessage?.message, depth + 1) ||
      hasGroupStatusMedia(message.associatedChildMessage?.message, depth + 1)
  );
}

function indexStatusForGroup(groupJid: string, statusId: string): void {
  const bare = normalizeBareJid(groupJid);
  if (!bare.endsWith('@g.us') || !statusId) return;
  const list = statusIdsByGroupKey.get(bare) || [];
  if (!list.includes(statusId)) {
    list.push(statusId);
  }
  list.sort(
    (a, b) => (statusesById.get(b)?.timestampMs || 0) - (statusesById.get(a)?.timestampMs || 0)
  );
  statusIdsByGroupKey.set(bare, list.slice(0, 30));
}

export async function recordBroadcastStatus(
  sock: WASocket,
  msg: WAMessage,
  sessionKey = 'main'
): Promise<CachedStatusEntry | null> {
  try {
    if (!msg.key?.id) return null;
    const isBroadcastStatus = msg.key.remoteJid === 'status@broadcast';
    const isGroupOrMentionStatus = hasGroupStatusMedia(msg.message);

    if (!isBroadcastStatus && !isGroupOrMentionStatus) {
      return null;
    }

    // Handle revoked/deleted status updates cleanly
    if (msg.message?.protocolMessage?.type === 0 && msg.message.protocolMessage.key?.id) {
      removeStatusById(msg.message.protocolMessage.key.id);
      return null;
    }

    // Ignore unavailable view-once status stubs or empty payloads without crashing
    if (!msg.message) {
      if (msg.key.isViewOnce || msg.messageStubParameters?.length) {
        logger.info('statusStore', `Ignored unavailable/view-once status (${msg.key.id}).`);
      }
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
    if (!isBroadcastStatus && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
      addRaw(msg.key.remoteJid);
    }
    const referencedCtx = extractContextInfo(msg.message);
    if (referencedCtx?.participant) addRaw(referencedCtx.participant);
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

    const msgTimestampMs = toTimestampMs(msg.messageTimestamp);
    const referencedIds = extractReferencedStatusIds(msg.message);
    const mentionTargets = extractStatusMentionTargets(msg.message);
    const chatBare = msg.key.remoteJid ? normalizeBareJid(msg.key.remoteJid) : '';

    // Always link group/DM status mention cards even when WhatsApp sends them as stubs without inline media
    if (!isBroadcastStatus && isGroupOrMentionStatus && msg.key.id) {
      const mentionRec: StatusMentionRecord = {
        mentionMsgId: msg.key.id,
        chatId: chatBare,
        referencedStatusIds: referencedIds,
        senderJids,
        senderPhone,
        pushName: cleanPush,
        timestampMs: msgTimestampMs,
      };
      mentionRecordsByMsgId.delete(msg.key.id);
      mentionRecordsByMsgId.set(msg.key.id, mentionRec);

      if (chatBare.endsWith('@g.us')) {
        const gList = mentionIdsByGroupKey.get(chatBare) || [];
        if (!gList.includes(msg.key.id)) gList.unshift(msg.key.id);
        mentionIdsByGroupKey.set(chatBare, gList.slice(0, 30));
      }

      for (const refId of referencedIds) {
        statusIdAliases.set(msg.key.id, refId);
        if (chatBare.endsWith('@g.us') && statusesById.has(refId)) {
          indexStatusForGroup(chatBare, refId);
        }
      }

      // Retroactively link matching broadcast statuses already cached from this author
      if (senderJids.length > 0 && referencedIds.length === 0) {
        const senderKeySet = new Set(buildUserKeys([...senderJids, senderPhone]));
        let closestId = '';
        let closestDelta = Infinity;
        for (const candidate of statusesById.values()) {
          if (candidate.mediaType === 'text') continue;
          const candidateKeys = buildUserKeys([...candidate.senderJids, candidate.senderPhone]);
          if (!candidateKeys.some((k) => senderKeySet.has(k))) continue;
          const delta = Math.abs(candidate.timestampMs - msgTimestampMs);
          if (delta <= 120_000 && delta < closestDelta) {
            closestDelta = delta;
            closestId = candidate.id;
          }
        }
        if (closestId) {
          statusIdAliases.set(msg.key.id, closestId);
          if (chatBare.endsWith('@g.us')) indexStatusForGroup(chatBare, closestId);
        }
      }
    }

    // Extract image, video, audio, or text status payload
    const extracted = extractStatusMediaPayload(msg.message);
    let textBody: string | undefined;
    let backgroundArgb: number | undefined;

    if (!extracted) {
      // Do not mistake an empty groupStatusMentionMessage stub for a text status!
      if (isStatusMentionStubMessage(msg.message)) {
        pruneExpiredStatuses();
        return null;
      }
      const unwrapped = unwrapMessage(msg.message) || msg.message;
      const textPreview = extractBodyText(msg.message).trim();
      if (!textPreview) {
        logger.info('statusStore', `Ignored non-media empty status update (${msg.key.id}).`);
        return null;
      }
      textBody = textPreview;
      backgroundArgb = unwrapped.extendedTextMessage?.backgroundArgb ?? undefined;
    } else if (!hasValidMediaPayload(extracted.inner)) {
      logger.info(
        'statusStore',
        `Ignored ${extracted.isViewOnce ? 'unsupported view-once' : 'incomplete'} status media (${msg.key.id}).`
      );
      return null;
    }

    if (senderJids.length === 0) return null;

    const prev = statusesById.get(msg.key.id);
    const mergedSessionKeys = Array.from(
      new Set([...(prev?.sessionKeys || []), sessionKey].filter(Boolean))
    );

    const entry: CachedStatusEntry = {
      id: msg.key.id,
      msg: { key: msg.key, message: extracted ? extracted.inner : msg.message },
      inner: extracted ? extracted.inner : msg.message,
      mediaType: extracted ? extracted.mediaType : 'text',
      caption: extracted?.caption || undefined,
      textBody,
      backgroundArgb,
      mimetype: extracted?.mimetype,
      ptt: extracted?.ptt,
      seconds: extracted?.seconds,
      senderJids,
      senderPhone,
      pushName: cleanPush,
      timestampMs: msgTimestampMs,
      sessionKeys: mergedSessionKeys,
      cachedBuffer: prev?.cachedBuffer,
    };

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

    // Index group statuses & statuses that mention groups
    if (chatBare.endsWith('@g.us')) {
      indexStatusForGroup(chatBare, entry.id);
    }
    for (const target of mentionTargets) {
      if (target.endsWith('@g.us')) {
        indexStatusForGroup(target, entry.id);
      }
    }

    // Back-link any mention cards that arrived just before this status@broadcast message
    const entryKeys = new Set(buildUserKeys([...senderJids, senderPhone]));
    for (const rec of mentionRecordsByMsgId.values()) {
      if (rec.referencedStatusIds.includes(entry.id)) {
        statusIdAliases.set(rec.mentionMsgId, entry.id);
        if (rec.chatId.endsWith('@g.us')) indexStatusForGroup(rec.chatId, entry.id);
        continue;
      }
      if (rec.referencedStatusIds.length === 0 && Math.abs(rec.timestampMs - entry.timestampMs) <= 120_000) {
        const recKeys = buildUserKeys([...rec.senderJids, rec.senderPhone]);
        if (recKeys.some((k) => entryKeys.has(k))) {
          if (!statusIdAliases.has(rec.mentionMsgId)) {
            statusIdAliases.set(rec.mentionMsgId, entry.id);
          }
          if (rec.chatId.endsWith('@g.us')) indexStatusForGroup(rec.chatId, entry.id);
        }
      }
    }

    pruneExpiredStatuses();

    // Pre-download status media buffer for media statuses
    if (extracted && !entry.cachedBuffer) {
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
  const direct = statusesById.get(msgId);
  if (direct) return direct;

  const aliasedId = statusIdAliases.get(msgId);
  if (aliasedId) {
    const aliased = statusesById.get(aliasedId);
    if (aliased) return aliased;
  }

  const mentionRec = mentionRecordsByMsgId.get(msgId);
  if (mentionRec) {
    for (const refId of mentionRec.referencedStatusIds) {
      const hit = statusesById.get(refId);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function getStatusMentionMeta(msgId: string): StatusMentionRecord | undefined {
  if (!msgId) return undefined;
  pruneExpiredStatuses();
  return mentionRecordsByMsgId.get(msgId);
}

export function findStatusesForUser(
  candidates: string[],
  includeText = false
): CachedStatusEntry[] {
  pruneExpiredStatuses();
  const keys = buildUserKeys(candidates);
  const found = new Map<string, CachedStatusEntry>();

  for (const key of keys) {
    const ids = statusIdsByUserKey.get(key) || [];
    for (const id of ids) {
      const entry = statusesById.get(id);
      if (entry && (includeText || entry.mediaType !== 'text')) found.set(id, entry);
    }
  }

  return Array.from(found.values()).sort((a, b) => b.timestampMs - a.timestampMs);
}

export function findStatusesForGroup(
  groupId: string,
  authorCandidates?: string[],
  includeText = false
): CachedStatusEntry[] {
  pruneExpiredStatuses();
  const bareGroup = normalizeBareJid(groupId);
  if (!bareGroup.endsWith('@g.us')) return [];

  const authorKeys =
    authorCandidates && authorCandidates.length > 0
      ? new Set(buildUserKeys(authorCandidates))
      : null;

  const found = new Map<string, CachedStatusEntry>();
  const groupStatusIds = statusIdsByGroupKey.get(bareGroup) || [];
  for (const id of groupStatusIds) {
    const entry = statusesById.get(id);
    if (!entry) continue;
    if (!includeText && entry.mediaType === 'text') continue;
    if (authorKeys) {
      const entryKeys = buildUserKeys([...entry.senderJids, entry.senderPhone]);
      if (!entryKeys.some((k) => authorKeys.has(k))) continue;
    }
    found.set(id, entry);
  }

  // Also check authors who posted a groupStatusMentionMessage in this group
  if (!authorKeys) {
    const mentionIds = mentionIdsByGroupKey.get(bareGroup) || [];
    for (const mId of mentionIds) {
      const direct = getStatusById(mId);
      if (direct && (includeText || direct.mediaType !== 'text')) {
        found.set(direct.id, direct);
        continue;
      }
      const rec = mentionRecordsByMsgId.get(mId);
      if (rec?.senderJids.length) {
        for (const s of findStatusesForUser(rec.senderJids, includeText)) {
          found.set(s.id, s);
        }
      }
    }
  }

  return Array.from(found.values()).sort((a, b) => b.timestampMs - a.timestampMs);
}

export function findLatestGroupMentionAuthors(groupId: string): StatusMentionRecord[] {
  pruneExpiredStatuses();
  const bareGroup = normalizeBareJid(groupId);
  if (!bareGroup.endsWith('@g.us')) return [];
  const ids = mentionIdsByGroupKey.get(bareGroup) || [];
  return ids
    .map((id) => mentionRecordsByMsgId.get(id))
    .filter((r): r is StatusMentionRecord => Boolean(r))
    .sort((a, b) => b.timestampMs - a.timestampMs);
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
    if (entry.mediaType === 'text') continue;
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

export function listStatusesForDashboard(
  limit = 80,
  sessionId?: string
): DashboardStatusItem[] {
  pruneExpiredStatuses();
  const cleanSession = String(sessionId || '').trim();
  const entries = Array.from(statusesById.values())
    .filter((entry) => !cleanSession || (entry.sessionKeys || []).includes(cleanSession))
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, Math.max(1, Math.min(200, limit)));

  return entries.map((entry) => ({
    id: entry.id,
    mediaType: entry.mediaType,
    caption: entry.caption,
    textBody: entry.textBody,
    backgroundArgb: entry.backgroundArgb,
    mimetype: entry.mimetype,
    ptt: entry.ptt,
    seconds: entry.seconds,
    senderPhone: entry.senderPhone,
    senderJid:
      entry.senderJids.find((j) => j.endsWith('@s.whatsapp.net')) || entry.senderJids[0] || '',
    pushName: entry.pushName,
    timestampMs: entry.timestampMs,
    hasBuffer: Boolean(entry.cachedBuffer && entry.cachedBuffer.length > 0),
    sessionKeys: entry.sessionKeys || [],
  }));
}
