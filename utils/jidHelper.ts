import {
  areJidsSameUser,
  extractMessageContent,
  isLidUser,
  jidNormalizedUser,
  type GroupMetadata,
  type GroupParticipant,
  type proto,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
export { isLidUser };
import { isValidPhone, normalizePhone } from '../config/bot.config.ts';

const groupMetaCache = new Map<string, { meta: GroupMetadata; expiresAt: number }>();
const GROUP_META_TTL_MS = 60_000;
const knownUserNames = new Map<string, string>();

export function rememberUserName(jidOrPhone: string | undefined | null, name: string | undefined | null): void {
  const cleanName = (name || '').trim();
  const key = jidUserPart(jidOrPhone);
  if (!key || !cleanName || cleanName === 'WhatsApp User') return;
  knownUserNames.set(key, cleanName);
  if (knownUserNames.size > 4000) {
    const oldest = knownUserNames.keys().next().value;
    if (oldest) knownUserNames.delete(oldest);
  }
}

export function lookupKnownUserName(jidOrPhone: string | undefined | null): string | null {
  const key = jidUserPart(jidOrPhone);
  if (!key) return null;
  return knownUserNames.get(key) || null;
}

export async function getCachedGroupMetadata(
  sock: WASocket,
  groupId: string,
  forceRefresh = false
): Promise<GroupMetadata> {
  const now = Date.now();
  const cached = groupMetaCache.get(groupId);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.meta;
  }
  const meta = await sock.groupMetadata(groupId);
  groupMetaCache.set(groupId, { meta, expiresAt: now + GROUP_META_TTL_MS });
  if (groupMetaCache.size > 2500) {
    for (const [key, val] of groupMetaCache.entries()) {
      if (val.expiresAt <= now) groupMetaCache.delete(key);
    }
    while (groupMetaCache.size > 2500) {
      const oldest = groupMetaCache.keys().next().value;
      if (!oldest) break;
      groupMetaCache.delete(oldest);
    }
  }
  return meta;
}

export async function getGroupMetadataFromCacheOnly(
  groupId: string
): Promise<GroupMetadata | undefined> {
  const cached = groupMetaCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.meta;
  }
  return undefined;
}

export function invalidateGroupMetadataCache(groupId?: string): void {
  if (!groupId) {
    groupMetaCache.clear();
    return;
  }
  groupMetaCache.delete(groupId);
}

export function hasValidMediaPayload(
  message: proto.IMessage | null | undefined
): boolean {
  if (!message) return false;
  const media =
    message.imageMessage ||
    message.videoMessage ||
    message.ptvMessage ||
    message.audioMessage ||
    message.stickerMessage ||
    message.documentMessage;
  if (!media) return false;
  const hasUrlOrPath = Boolean(
    (typeof media.url === 'string' && media.url.trim().length > 0) ||
      (typeof media.directPath === 'string' && media.directPath.trim().length > 0)
  );
  const key = media.mediaKey as unknown;
  const hasKey = Boolean(
    key &&
      ((key instanceof Uint8Array && key.length > 0) ||
        (Buffer.isBuffer(key) && key.length > 0) ||
        (typeof key === 'string' && key.length > 0) ||
        (typeof key === 'object' && Array.isArray((key as { data?: number[] }).data) && (key as { data: number[] }).data.length > 0) ||
        (typeof key === 'object' && !Array.isArray(key) && '0' in (key as Record<string, unknown>)))
  );
  return hasUrlOrPath && hasKey;
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
  return match ? match[0] : null;
}

export function extractGroupInviteCode(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{18,26}$/.test(trimmed)) return trimmed;
  return '';
}

export function extractGroupInviteCodes(input: string): string[] {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const codes = new Set<string>();
  for (const match of raw.matchAll(/chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi)) {
    if (match[1]) codes.add(match[1]);
  }
  for (const part of raw.split(/[\s,;]+/)) {
    const code = extractGroupInviteCode(part);
    if (code) codes.add(code);
  }
  return Array.from(codes);
}

export function extractChannelTargets(
  input: string
): Array<{ type: 'invite' | 'jid'; value: string }> {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const targets: Array<{ type: 'invite' | 'jid'; value: string }> = [];

  for (const part of raw.split(/[\s,;]+/)) {
    const token = part.trim();
    if (!token) continue;
    const urlMatch = token.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]{12,40})/i);
    if (urlMatch?.[1]) {
      const key = `invite:${urlMatch[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ type: 'invite', value: urlMatch[1] });
      }
      continue;
    }
    if (/^[0-9]{10,30}@newsletter$/i.test(token)) {
      const key = `jid:${token.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ type: 'jid', value: token.toLowerCase() });
      }
      continue;
    }
    if (/^0029[A-Za-z0-9_-]{14,32}$/.test(token)) {
      const key = `invite:${token}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ type: 'invite', value: token });
      }
    }
  }

  return targets;
}

export function normalizeBareJid(jid: string | undefined | null): string {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid);
  } catch {
    return String(jid).replace(/:\d+(?=@)/, '');
  }
}

export function jidUserPart(jid: string | undefined | null): string {
  if (!jid) return '';
  return normalizeBareJid(jid).split('@')[0];
}

export function isParticipantAdmin(p: GroupParticipant | undefined | null): boolean {
  if (!p) return false;
  return Boolean(
    p.admin === 'admin' ||
      p.admin === 'superadmin' ||
      p.isAdmin ||
      p.isSuperAdmin
  );
}

/**
 * Collects all possible PN + LID JIDs for the current bot socket so group admin checks
 * work reliably in both @s.whatsapp.net and Baileys v7 @lid groups.
 */
export async function getBotJids(sock: WASocket): Promise<string[]> {
  const candidates = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    const bare = normalizeBareJid(raw);
    if (bare) candidates.add(bare);
  };

  add(sock.user?.id);
  add(sock.user?.lid);
  add(sock.authState?.creds?.me?.id);
  add(sock.authState?.creds?.me?.lid);

  const mePn = normalizeBareJid(sock.user?.id || sock.authState?.creds?.me?.id);
  if (mePn && sock.signalRepository?.lidMapping?.getLIDForPN) {
    try {
      const mappedLid = await sock.signalRepository.lidMapping.getLIDForPN(mePn);
      add(mappedLid);
    } catch {
      // Ignore missing LID mapping
    }
  }

  return Array.from(candidates);
}

export function participantMatchesAny(
  p: GroupParticipant,
  targetJids: string[]
): boolean {
  const pIds = [p.id, p.lid, p.phoneNumber]
    .filter((v): v is string => Boolean(v))
    .map((v) => normalizeBareJid(v));

  for (const target of targetJids) {
    const cleanTarget = normalizeBareJid(target);
    if (!cleanTarget) continue;
    const targetUser = jidUserPart(cleanTarget);

    for (const pid of pIds) {
      if (areJidsSameUser(pid, cleanTarget)) return true;
      if (pid === cleanTarget) return true;
      if (targetUser && jidUserPart(pid) === targetUser) return true;
    }
  }
  return false;
}

export function findParticipant(
  participants: GroupParticipant[],
  targetJids: string[]
): GroupParticipant | undefined {
  if (targetJids.length === 0) return undefined;
  return participants.find((p) => participantMatchesAny(p, targetJids));
}

export async function resolveSenderInfo(
  sock: WASocket,
  msg: WAMessage
): Promise<{
  senderJid: string;
  senderCandidates: string[];
  senderNumber: string;
}> {
  const chatId = msg.key?.remoteJid || '';
  const isGroup = chatId.endsWith('@g.us');
  const candidates = new Set<string>();

  const add = (raw?: string | null) => {
    if (!raw) return;
    const bare = normalizeBareJid(raw);
    if (bare) candidates.add(bare);
  };

  if (isGroup) {
    add(msg.key?.participantAlt);
    add(msg.key?.participant);
    if (msg.key?.fromMe) {
      add(sock.user?.id);
      add(sock.user?.lid);
      add(sock.authState?.creds?.me?.id);
      add(sock.authState?.creds?.me?.lid);
    }
  } else if (msg.key?.fromMe) {
    add(sock.user?.id);
    add(sock.user?.lid);
    add(sock.authState?.creds?.me?.id);
    add(sock.authState?.creds?.me?.lid);
  } else {
    add(msg.key?.remoteJidAlt);
    add(chatId);
  }

  // Try LID -> PN lookup if sender is still an @lid JID
  const primaryRaw = isGroup
    ? msg.key?.participantAlt || msg.key?.participant || chatId
    : msg.key?.fromMe
      ? sock.user?.id || chatId
      : msg.key?.remoteJidAlt || chatId;
  const primaryBare = normalizeBareJid(primaryRaw);

  if (primaryBare && isLidUser(primaryBare) && sock.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(primaryBare);
      if (pn) add(pn);
    } catch {
      // Ignore mapping failure
    }
  }

  const allCandidates = Array.from(candidates);
  const pnJid =
    allCandidates.find((j) => j.endsWith('@s.whatsapp.net')) ||
    primaryBare ||
    chatId;

  const senderNumber = normalizePhone(jidUserPart(pnJid));

  return {
    senderJid: primaryBare || pnJid,
    senderCandidates: allCandidates,
    senderNumber,
  };
}

export function unwrapMessage(
  message: proto.IMessage | null | undefined
): proto.IMessage | undefined {
  if (!message) return undefined;
  let current: proto.IMessage | undefined = message;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const next: proto.IMessage | null | undefined =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message ||
      current.botInvokeMessage?.message ||
      current.groupStatusMessage?.message ||
      current.groupStatusMessageV2?.message ||
      current.editedMessage?.message?.protocolMessage?.editedMessage ||
      current.associatedChildMessage?.message;
    if (!next) break;
    current = next;
  }
  return extractMessageContent(current) || current;
}

export function extractBodyText(message: proto.IMessage | null | undefined): string {
  const inner = unwrapMessage(message);
  if (!inner) return '';
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    inner.buttonsResponseMessage?.selectedButtonId ||
    inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
    inner.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

export function extractContextInfo(
  message: proto.IMessage | null | undefined
): proto.IContextInfo | undefined {
  const inner = unwrapMessage(message);
  if (!inner) return undefined;
  return (
    inner.extendedTextMessage?.contextInfo ||
    inner.imageMessage?.contextInfo ||
    inner.videoMessage?.contextInfo ||
    inner.ptvMessage?.contextInfo ||
    inner.audioMessage?.contextInfo ||
    inner.stickerMessage?.contextInfo ||
    inner.documentMessage?.contextInfo ||
    undefined
  );
}

export function resolveGroupTargetJids(
  participants: GroupParticipant[],
  rawTargets: string[]
): string[] {
  const resolved: string[] = [];
  for (const raw of rawTargets) {
    const matched = findParticipant(participants, [raw]);
    if (matched) {
      resolved.push(matched.id);
    } else {
      resolved.push(normalizeBareJid(raw));
    }
  }
  return Array.from(new Set(resolved.filter(Boolean)));
}

export function extractRawTargetCandidates(
  msg: WAMessage | null,
  args: string[]
): string[] {
  const ctxInfo = extractContextInfo(msg?.message);
  const mentioned = ctxInfo?.mentionedJid || [];
  if (mentioned.length > 0) return mentioned.map((j) => normalizeBareJid(j));

  if (ctxInfo?.participant) {
    return [normalizeBareJid(ctxInfo.participant)];
  }

  const rawArg = (args[0] || '').trim();
  if (rawArg) {
    if (/^[0-9]{5,30}@(s\.whatsapp\.net|lid)$/i.test(rawArg)) {
      return [normalizeBareJid(rawArg)];
    }
    const stripped = rawArg.replace(/^@/, '');
    const num = normalizePhone(stripped);
    if (isValidPhone(num)) {
      return [`${num}@s.whatsapp.net`];
    }
  }
  return [];
}
