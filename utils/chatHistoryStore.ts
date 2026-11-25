import type { GroupMetadata, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  getBotJids,
  isLidUser,
  isParticipantAdmin,
  jidUserPart,
  lookupKnownUserName,
  normalizeBareJid,
  rememberUserName,
  unwrapMessage,
} from './jidHelper.ts';
import { detectMediaType } from './mediaHelper.ts';

export interface ChatHistoryEntry {
  senderJid: string;
  senderName: string;
  text: string;
  timestamp: number;
}

const MAX_CHATS = 400;
const MAX_MESSAGES_PER_CHAT = 120;
const chatHistoryMap = new Map<string, ChatHistoryEntry[]>();

export function recordChatMessage(
  chatId: string,
  senderJid: string,
  senderName: string,
  text: string,
  timestamp = Date.now()
): void {
  const cleanText = text.trim();
  if (!chatId || !cleanText) return;

  let list = chatHistoryMap.get(chatId);
  if (!list) {
    list = [];
    chatHistoryMap.set(chatId, list);
    if (chatHistoryMap.size > MAX_CHATS) {
      const oldest = chatHistoryMap.keys().next().value;
      if (oldest) chatHistoryMap.delete(oldest);
    }
  }

  list.push({
    senderJid,
    senderName: senderName.trim() || 'Member',
    text: cleanText.slice(0, 600),
    timestamp,
  });

  if (list.length > MAX_MESSAGES_PER_CHAT) {
    list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
  }
}

export function getRecentChatMessages(chatId: string, limit = 60): ChatHistoryEntry[] {
  const list = chatHistoryMap.get(chatId) || [];
  const safeLimit = Math.max(1, Math.min(MAX_MESSAGES_PER_CHAT, limit));
  return list.slice(-safeLimit);
}

// ── Per-Session Live Chatting & Group Monitor Store (Main + Paid/VIP Paired Sessions) ──

export type MonitorMediaType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'document'
  | 'contact'
  | 'location'
  | 'poll'
  | 'other';

export interface SessionChatSummary {
  sessionId: string;
  chatId: string;
  isGroup: boolean;
  title: string;
  phone?: string;
  participantCount?: number;
  isAdmin?: boolean;
  announce?: boolean;
  lastMessage: string;
  lastSender: string;
  lastFromMe: boolean;
  lastTimestamp: number;
  messageCount: number;
}

export interface SessionLiveMessage {
  id: string;
  sessionId: string;
  chatId: string;
  chatTitle: string;
  isGroup: boolean;
  fromMe: boolean;
  senderJid: string;
  senderPhone: string;
  senderName: string;
  mediaType: MonitorMediaType;
  text: string;
  timestamp: number;
}

interface SessionMonitorBucket {
  contacts: Map<string, string>;
  chats: Map<string, SessionChatSummary>;
  messagesByChat: Map<string, SessionLiveMessage[]>;
  liveFeed: SessionLiveMessage[];
  seenMsgIds: Set<string>;
}

const MAX_MONITOR_CHATS_PER_SESSION = 500;
const MAX_MONITOR_MSGS_PER_CHAT = 150;
const MAX_MONITOR_LIVE_FEED = 200;

const sessionBuckets = new Map<string, SessionMonitorBucket>();

function getBucket(sessionId: string): SessionMonitorBucket {
  const key = sessionId || 'main';
  let bucket = sessionBuckets.get(key);
  if (!bucket) {
    bucket = {
      contacts: new Map<string, string>(),
      chats: new Map<string, SessionChatSummary>(),
      messagesByChat: new Map<string, SessionLiveMessage[]>(),
      liveFeed: [],
      seenMsgIds: new Set<string>(),
    };
    sessionBuckets.set(key, bucket);
  }
  return bucket;
}

function summarizeMessageContent(msg: WAMessage): {
  mediaType: MonitorMediaType;
  text: string;
} {
  const message = msg.message;
  if (!message) return { mediaType: 'other', text: '' };

  const inner = unwrapMessage(message) || message;
  const body = extractBodyText(message).trim();
  const detected = detectMediaType(message);

  if (detected === 'image') {
    return { mediaType: 'image', text: body ? `[Photo] ${body}` : '[Photo]' };
  }
  if (detected === 'video') {
    return { mediaType: 'video', text: body ? `[Video] ${body}` : '[Video]' };
  }
  if (detected === 'audio') {
    const isPtt = Boolean(inner.audioMessage?.ptt);
    return { mediaType: 'audio', text: isPtt ? '[Voice Note]' : '[Audio]' };
  }
  if (detected === 'sticker') {
    return { mediaType: 'sticker', text: '[Sticker]' };
  }
  if (inner.documentMessage) {
    const fileName = inner.documentMessage.fileName || 'File';
    return {
      mediaType: 'document',
      text: body ? `[Document: ${fileName}] ${body}` : `[Document: ${fileName}]`,
    };
  }
  if (inner.contactMessage || inner.contactsArrayMessage) {
    const label = inner.contactMessage?.displayName || 'Contact';
    return { mediaType: 'contact', text: `[Contact: ${label}]` };
  }
  if (inner.locationMessage || inner.liveLocationMessage) {
    return { mediaType: 'location', text: '[Location]' };
  }
  if (inner.pollCreationMessage || inner.pollCreationMessageV3) {
    const pollName =
      inner.pollCreationMessage?.name || inner.pollCreationMessageV3?.name || 'Poll';
    return { mediaType: 'poll', text: `[Poll] ${pollName}` };
  }
  if (inner.reactionMessage?.text) {
    return { mediaType: 'other', text: `[Reacted ${inner.reactionMessage.text}]` };
  }
  if (body) {
    return { mediaType: 'text', text: body };
  }
  return { mediaType: 'other', text: '[Message]' };
}

function resolveFriendlyTitle(
  bucket: SessionMonitorBucket,
  jid: string,
  isGroup: boolean,
  fallbackPushName?: string | null
): { title: string; phone?: string } {
  const bare = normalizeBareJid(jid);
  const user = jidUserPart(bare);
  const phone = !isGroup && user ? normalizePhone(user) || user : undefined;

  if (isGroup) {
    const existing = bucket.chats.get(bare);
    if (existing?.title && existing.title !== bare) {
      return { title: existing.title };
    }
    return { title: bare };
  }

  const fromContact =
    bucket.contacts.get(bare) ||
    (phone ? bucket.contacts.get(`${phone}@s.whatsapp.net`) : undefined) ||
    (user ? bucket.contacts.get(user) : undefined) ||
    lookupKnownUserName(bare) ||
    (phone ? lookupKnownUserName(phone) : '');

  const cleanPush = (fallbackPushName || '').trim();
  const title = fromContact || cleanPush || (phone ? `+${phone}` : bare);
  return { title, phone };
}

export const sessionChatMonitor = {
  recordContactNames(
    sessionId: string,
    contacts: Array<{ id?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }>
  ): void {
    const bucket = getBucket(sessionId);
    for (const c of contacts || []) {
      const bare = normalizeBareJid(c?.id);
      if (!bare) continue;
      const label = (c.name || c.notify || c.verifiedName || '').trim();
      if (!label) continue;
      bucket.contacts.set(bare, label);
      const user = jidUserPart(bare);
      if (user) bucket.contacts.set(user, label);
      rememberUserName(bare, label);

      const chat = bucket.chats.get(bare);
      if (chat && !chat.isGroup) {
        chat.title = label;
      }
    }
  },

  upsertSessionChatsMetadata(
    sessionId: string,
    chats: Array<{ id?: string | null; name?: string | null; subject?: string | null; conversationTimestamp?: number | LongLike | null }>
  ): void {
    const bucket = getBucket(sessionId);
    for (const c of chats || []) {
      const bare = normalizeBareJid(c?.id);
      if (!bare || bare === 'status@broadcast' || bare.endsWith('@newsletter')) continue;
      const isGroup = bare.endsWith('@g.us');
      const label = (c.subject || c.name || '').trim();
      if (label) {
        bucket.contacts.set(bare, label);
      }
      const existing = bucket.chats.get(bare);
      const tsNum = Number(c.conversationTimestamp || 0);
      const tsMs = tsNum > 0 ? (tsNum > 1e12 ? tsNum : tsNum * 1000) : 0;

      if (existing) {
        if (label) existing.title = label;
        if (tsMs > existing.lastTimestamp) existing.lastTimestamp = tsMs;
      } else {
        const user = jidUserPart(bare);
        bucket.chats.set(bare, {
          sessionId,
          chatId: bare,
          isGroup,
          title: label || (isGroup ? bare : `+${normalizePhone(user) || user}`),
          phone: !isGroup ? normalizePhone(user) || user : undefined,
          lastMessage: '',
          lastSender: '',
          lastFromMe: false,
          lastTimestamp: tsMs,
          messageCount: 0,
        });
      }
    }
  },

  upsertSessionGroups(
    sessionId: string,
    groups: Record<string, GroupMetadata> | GroupMetadata[],
    ownJids: string[] = []
  ): void {
    const bucket = getBucket(sessionId);
    const list = Array.isArray(groups) ? groups : Object.values(groups || {});
    const ownParts = new Set(ownJids.map((j) => jidUserPart(j)).filter(Boolean));

    for (const meta of list) {
      if (!meta?.id || !meta.id.endsWith('@g.us')) continue;
      const bare = normalizeBareJid(meta.id);
      const existing = bucket.chats.get(bare);
      const participantCount = Array.isArray(meta.participants)
        ? meta.participants.length
        : existing?.participantCount;
      const botP = Array.isArray(meta.participants)
        ? meta.participants.find(
            (p) =>
              ownParts.has(jidUserPart(p.id)) ||
              (p.phoneNumber ? ownParts.has(jidUserPart(p.phoneNumber)) : false)
          )
        : undefined;
      const isAdmin = botP ? isParticipantAdmin(botP) : existing?.isAdmin;
      const title = (meta.subject || existing?.title || bare).trim();

      bucket.chats.set(bare, {
        sessionId,
        chatId: bare,
        isGroup: true,
        title,
        participantCount,
        isAdmin,
        announce: typeof meta.announce === 'boolean' ? meta.announce : existing?.announce,
        lastMessage: existing?.lastMessage || '',
        lastSender: existing?.lastSender || '',
        lastFromMe: existing?.lastFromMe || false,
        lastTimestamp: existing?.lastTimestamp || 0,
        messageCount: existing?.messageCount || 0,
      });
    }
  },

  async recordMessage(sessionId: string, msg: WAMessage, sock?: WASocket | null): Promise<void> {
    if (!msg?.message || !msg.key?.remoteJid) return;
    const rawChat = normalizeBareJid(msg.key.remoteJid);
    if (!rawChat || rawChat === 'status@broadcast' || rawChat.endsWith('@newsletter')) return;
    if (msg.message.protocolMessage && msg.message.protocolMessage.type !== 0) return;

    const { mediaType, text } = summarizeMessageContent(msg);
    if (!text) return;

    const bucket = getBucket(sessionId);
    const msgId = msg.key.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (msg.key.id && bucket.seenMsgIds.has(msg.key.id)) return;
    if (msg.key.id) {
      bucket.seenMsgIds.add(msg.key.id);
      if (bucket.seenMsgIds.size > 4000) {
        const oldest = bucket.seenMsgIds.values().next().value;
        if (oldest) bucket.seenMsgIds.delete(oldest);
      }
    }

    let resolvedChatId = rawChat;
    if (!rawChat.endsWith('@g.us') && msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
      resolvedChatId = normalizeBareJid(msg.key.remoteJidAlt);
    } else if (!rawChat.endsWith('@g.us') && isLidUser(rawChat) && sock?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(rawChat);
        if (pn) resolvedChatId = normalizeBareJid(pn);
      } catch {
        // Ignore missing LID mapping
      }
    }

    const isGroup = resolvedChatId.endsWith('@g.us');
    const fromMe = Boolean(msg.key.fromMe);

    let senderJid = normalizeBareJid(
      fromMe
        ? sock?.user?.id || resolvedChatId
        : isGroup
          ? msg.key.participantAlt || msg.key.participant || resolvedChatId
          : resolvedChatId
    );
    if (!fromMe && isLidUser(senderJid) && sock?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
        if (pn) senderJid = normalizeBareJid(pn);
      } catch {
        // Keep original JID
      }
    }

    const senderPhone = normalizePhone(jidUserPart(senderJid)) || jidUserPart(senderJid);
    let senderName = fromMe ? 'You (Paired)' : (msg.pushName || '').trim();
    if (!fromMe && senderName) {
      rememberUserName(senderJid, senderName);
      if (senderPhone) rememberUserName(senderPhone, senderName);
      bucket.contacts.set(senderJid, senderName);
    }
    if (!senderName) {
      senderName =
        bucket.contacts.get(senderJid) ||
        lookupKnownUserName(senderJid) ||
        (senderPhone ? `+${senderPhone}` : 'User');
    }

    const tsRaw = Number(msg.messageTimestamp || 0);
    const timestamp =
      tsRaw > 0 ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : Date.now();

    const { title: chatTitle, phone: chatPhone } = resolveFriendlyTitle(
      bucket,
      resolvedChatId,
      isGroup,
      !fromMe ? msg.pushName : undefined
    );

    const entry: SessionLiveMessage = {
      id: msgId,
      sessionId,
      chatId: resolvedChatId,
      chatTitle,
      isGroup,
      fromMe,
      senderJid,
      senderPhone,
      senderName,
      mediaType,
      text: text.slice(0, 900),
      timestamp,
    };

    const existingChat = bucket.chats.get(resolvedChatId);
    if (existingChat) {
      if (!isGroup && chatTitle && !chatTitle.startsWith('+')) {
        existingChat.title = chatTitle;
      }
      if (timestamp >= existingChat.lastTimestamp) {
        existingChat.lastMessage = entry.text;
        existingChat.lastSender = senderName;
        existingChat.lastFromMe = fromMe;
        existingChat.lastTimestamp = timestamp;
      }
      existingChat.messageCount += 1;
    } else {
      bucket.chats.set(resolvedChatId, {
        sessionId,
        chatId: resolvedChatId,
        isGroup,
        title: chatTitle,
        phone: chatPhone,
        lastMessage: entry.text,
        lastSender: senderName,
        lastFromMe: fromMe,
        lastTimestamp: timestamp,
        messageCount: 1,
      });
      if (bucket.chats.size > MAX_MONITOR_CHATS_PER_SESSION) {
        const oldestKey = bucket.chats.keys().next().value;
        if (oldestKey) bucket.chats.delete(oldestKey);
      }
    }

    let chatMsgs = bucket.messagesByChat.get(resolvedChatId);
    if (!chatMsgs) {
      chatMsgs = [];
      bucket.messagesByChat.set(resolvedChatId, chatMsgs);
    }
    chatMsgs.push(entry);
    if (chatMsgs.length > MAX_MONITOR_MSGS_PER_CHAT) {
      chatMsgs.splice(0, chatMsgs.length - MAX_MONITOR_MSGS_PER_CHAT);
    }

    bucket.liveFeed.push(entry);
    if (bucket.liveFeed.length > MAX_MONITOR_LIVE_FEED) {
      bucket.liveFeed.splice(0, bucket.liveFeed.length - MAX_MONITOR_LIVE_FEED);
    }

    // Lazily enrich group subject if not known yet
    if (isGroup && existingChat?.title === resolvedChatId && sock?.groupMetadata) {
      void sock
        .groupMetadata(resolvedChatId)
        .then(async (meta) => {
          const ownJids = await getBotJids(sock).catch(() => [] as string[]);
          this.upsertSessionGroups(sessionId, [meta], ownJids);
        })
        .catch(() => {});
    }
  },

  listChats(sessionId: string): {
    groups: SessionChatSummary[];
    dms: SessionChatSummary[];
    all: SessionChatSummary[];
  } {
    const bucket = getBucket(sessionId);
    const all = Array.from(bucket.chats.values()).sort((a, b) => {
      if (b.lastTimestamp !== a.lastTimestamp) return b.lastTimestamp - a.lastTimestamp;
      return a.title.localeCompare(b.title);
    });
    return {
      groups: all.filter((c) => c.isGroup),
      dms: all.filter((c) => !c.isGroup),
      all,
    };
  },

  getChatMessages(sessionId: string, chatId: string, limit = 100): SessionLiveMessage[] {
    const bucket = getBucket(sessionId);
    const bare = normalizeBareJid(chatId);
    const list = bucket.messagesByChat.get(bare) || [];
    return list.slice(-Math.max(1, Math.min(MAX_MONITOR_MSGS_PER_CHAT, limit)));
  },

  getLiveFeed(sessionId: string, limit = 120): SessionLiveMessage[] {
    const bucket = getBucket(sessionId);
    return bucket.liveFeed.slice(-Math.max(1, Math.min(MAX_MONITOR_LIVE_FEED, limit)));
  },

  getStats(sessionId: string): {
    totalGroups: number;
    totalDms: number;
    totalMessages: number;
  } {
    const bucket = getBucket(sessionId);
    let totalGroups = 0;
    let totalDms = 0;
    let totalMessages = 0;
    for (const c of bucket.chats.values()) {
      if (c.isGroup) totalGroups += 1;
      else totalDms += 1;
      totalMessages += c.messageCount;
    }
    return { totalGroups, totalDms, totalMessages };
  },
};

type LongLike = { toNumber?: () => number; low?: number };
