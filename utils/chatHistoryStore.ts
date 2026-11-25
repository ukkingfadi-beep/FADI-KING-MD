import {
  dbGetSync,
  dbSetSync,
  registerDbHydrationHook,
} from './db.ts';

export interface ChatHistoryEntry {
  senderJid: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export type LiveChatMediaType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'document'
  | 'location'
  | 'contact'
  | 'poll'
  | 'payment'
  | 'other';

export interface LiveChatMessageKey {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  participant?: string;
}

export interface LiveChatMessage {
  id: string;
  chatId: string;
  senderJid: string;
  senderNumber: string;
  senderName: string;
  fromMe: boolean;
  text: string;
  mediaType: LiveChatMediaType;
  mimetype?: string;
  fileName?: string;
  hasMedia?: boolean;
  ptt?: boolean;
  seconds?: number;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
  timestamp: number;
  key?: LiveChatMessageKey;
}

export interface LiveChatThread {
  chatId: string;
  chatType: 'dm' | 'group';
  name: string;
  phone: string;
  lastMessage: string;
  lastSenderName: string;
  lastFromMe: boolean;
  lastTimestamp: number;
  messageCount: number;
  messages: LiveChatMessage[];
}

export interface LiveChatThreadSummary {
  chatId: string;
  chatType: 'dm' | 'group';
  name: string;
  phone: string;
  lastMessage: string;
  lastSenderName: string;
  lastFromMe: boolean;
  lastTimestamp: number;
  messageCount: number;
}

const MAX_CHATS = 400;
const MAX_MESSAGES_PER_CHAT = 120;
const MAX_SESSIONS = 80;
const MAX_THREADS_PER_SESSION = 300;
const MAX_LIVE_MESSAGES_PER_THREAD = 100;

const chatHistoryMap = new Map<string, ChatHistoryEntry[]>();
let sessionChatsMap: Map<string, Map<string, LiveChatThread>> | null = null;
let persistTimer: NodeJS.Timeout | null = null;

registerDbHydrationHook(() => {
  sessionChatsMap = null;
});

function ensureSessionChatsMap(): Map<string, Map<string, LiveChatThread>> {
  if (sessionChatsMap) return sessionChatsMap;
  const map = new Map<string, Map<string, LiveChatThread>>();
  const saved = dbGetSync<Record<string, LiveChatThread[]>>('live_chats_snapshot');
  if (saved && typeof saved === 'object') {
    for (const [sessionId, threads] of Object.entries(saved)) {
      if (!Array.isArray(threads)) continue;
      const inner = new Map<string, LiveChatThread>();
      for (const t of threads) {
        if (t && typeof t.chatId === 'string') {
          inner.set(t.chatId, {
            ...t,
            messages: Array.isArray(t.messages) ? t.messages.slice(-40) : [],
          });
        }
      }
      if (inner.size > 0) map.set(sessionId, inner);
    }
  }
  sessionChatsMap = map;
  return sessionChatsMap;
}

function schedulePersistSnapshot(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const store = ensureSessionChatsMap();
      const serialized: Record<string, LiveChatThread[]> = {};
      for (const [sessionId, threads] of store.entries()) {
        const sorted = Array.from(threads.values())
          .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
          .slice(0, 60)
          .map((t) => ({
            ...t,
            messages: t.messages.slice(-30),
          }));
        if (sorted.length > 0) {
          serialized[sessionId] = sorted;
        }
      }
      dbSetSync('live_chats_snapshot', serialized);
    } catch {
      // Ignore transient DB write failures
    }
  }, 2500);
  if (typeof persistTimer.unref === 'function') {
    persistTimer.unref();
  }
}

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

function getOrCreateSessionThreads(sessionId: string): Map<string, LiveChatThread> {
  const store = ensureSessionChatsMap();
  let threads = store.get(sessionId);
  if (!threads) {
    threads = new Map<string, LiveChatThread>();
    store.set(sessionId, threads);
    if (store.size > MAX_SESSIONS) {
      const oldest = store.keys().next().value;
      if (oldest) store.delete(oldest);
    }
  }
  return threads;
}

function normalizePhoneLabel(chatId: string): string {
  const userPart = chatId.split('@')[0].split(':')[0];
  const digits = userPart.replace(/\D/g, '');
  return digits.length >= 6 ? digits : userPart;
}

export function upsertSessionChatMeta(
  sessionId: string,
  chatId: string,
  chatName?: string,
  timestamp?: number
): void {
  if (!sessionId || !chatId || chatId === 'status@broadcast') return;
  const threads = getOrCreateSessionThreads(sessionId);
  const existing = threads.get(chatId);
  const isGroup = chatId.endsWith('@g.us');
  const phone = isGroup ? '' : normalizePhoneLabel(chatId);
  const cleanName = String(chatName || '').trim();
  const resolvedName =
    cleanName ||
    existing?.name ||
    (isGroup ? `Group ${chatId.slice(0, 12)}` : phone ? `+${phone}` : chatId);

  if (existing) {
    if (cleanName && (!existing.name || existing.name.startsWith('+') || existing.name.startsWith('Group '))) {
      existing.name = cleanName;
    }
    if (timestamp && timestamp > existing.lastTimestamp) {
      existing.lastTimestamp = timestamp;
    }
    schedulePersistSnapshot();
    return;
  }

  if (threads.size >= MAX_THREADS_PER_SESSION) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of threads.entries()) {
      if (v.lastTimestamp < oldestTs) {
        oldestTs = v.lastTimestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) threads.delete(oldestKey);
  }

  threads.set(chatId, {
    chatId,
    chatType: isGroup ? 'group' : 'dm',
    name: resolvedName,
    phone,
    lastMessage: '',
    lastSenderName: '',
    lastFromMe: false,
    lastTimestamp: timestamp || Date.now(),
    messageCount: 0,
    messages: [],
  });
  schedulePersistSnapshot();
}

export function recordSessionChatMessage(
  sessionId: string,
  entry: LiveChatMessage & { chatName?: string }
): void {
  if (!sessionId || !entry.chatId || entry.chatId === 'status@broadcast') return;
  const cleanText = String(entry.text || '').trim();
  if (!cleanText) return;

  const threads = getOrCreateSessionThreads(sessionId);
  let thread = threads.get(entry.chatId);
  const isGroup = entry.chatId.endsWith('@g.us');
  const phone = isGroup ? '' : normalizePhoneLabel(entry.chatId);
  const cleanChatName = String(entry.chatName || '').trim();

  if (!thread) {
    if (threads.size >= MAX_THREADS_PER_SESSION) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, v] of threads.entries()) {
        if (v.lastTimestamp < oldestTs) {
          oldestTs = v.lastTimestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) threads.delete(oldestKey);
    }

    thread = {
      chatId: entry.chatId,
      chatType: isGroup ? 'group' : 'dm',
      name: cleanChatName || (isGroup ? `Group ${entry.chatId.slice(0, 12)}` : phone ? `+${phone}` : entry.chatId),
      phone,
      lastMessage: '',
      lastSenderName: '',
      lastFromMe: false,
      lastTimestamp: entry.timestamp || Date.now(),
      messageCount: 0,
      messages: [],
    };
    threads.set(entry.chatId, thread);
  } else if (
    cleanChatName &&
    (!thread.name || thread.name.startsWith('+') || thread.name.startsWith('Group ') || !isGroup)
  ) {
    if (!(entry.fromMe && !isGroup && thread.name && !thread.name.startsWith('+'))) {
      thread.name = cleanChatName;
    }
  }

  // Deduplicate by message id if already stored
  const existingIdx = thread.messages.findIndex((m) => m.id === entry.id);
  const normalizedMsg: LiveChatMessage = {
    id: entry.id,
    chatId: entry.chatId,
    senderJid: entry.senderJid,
    senderNumber: entry.senderNumber,
    senderName: entry.senderName.trim() || (entry.fromMe ? 'You' : `+${entry.senderNumber || 'User'}`),
    fromMe: Boolean(entry.fromMe),
    text: cleanText.slice(0, 2000),
    mediaType: entry.mediaType || 'text',
    ...(entry.mimetype ? { mimetype: entry.mimetype } : {}),
    ...(entry.fileName ? { fileName: entry.fileName } : {}),
    ...(entry.hasMedia ? { hasMedia: true } : {}),
    ...(entry.ptt ? { ptt: true } : {}),
    ...(typeof entry.seconds === 'number' && entry.seconds > 0 ? { seconds: entry.seconds } : {}),
    ...(typeof entry.locationLat === 'number' ? { locationLat: entry.locationLat } : {}),
    ...(typeof entry.locationLng === 'number' ? { locationLng: entry.locationLng } : {}),
    ...(entry.locationName ? { locationName: entry.locationName } : {}),
    timestamp: entry.timestamp || Date.now(),
    key: entry.key,
  };

  if (existingIdx >= 0) {
    thread.messages[existingIdx] = normalizedMsg;
  } else {
    thread.messages.push(normalizedMsg);
    thread.messages.sort((a, b) => a.timestamp - b.timestamp);
    if (thread.messages.length > MAX_LIVE_MESSAGES_PER_THREAD) {
      thread.messages.splice(0, thread.messages.length - MAX_LIVE_MESSAGES_PER_THREAD);
    }
    thread.messageCount += 1;
  }

  const latest = thread.messages[thread.messages.length - 1];
  if (latest) {
    thread.lastMessage = latest.text.slice(0, 220);
    thread.lastSenderName = latest.senderName;
    thread.lastFromMe = latest.fromMe;
    thread.lastTimestamp = Math.max(thread.lastTimestamp, latest.timestamp);
  }

  schedulePersistSnapshot();
}

export function listSessionChats(sessionId: string): LiveChatThreadSummary[] {
  const store = ensureSessionChatsMap();
  const threads = store.get(sessionId);
  if (!threads) return [];
  return Array.from(threads.values())
    .map((t) => ({
      chatId: t.chatId,
      chatType: t.chatType,
      name: t.name,
      phone: t.phone,
      lastMessage: t.lastMessage,
      lastSenderName: t.lastSenderName,
      lastFromMe: t.lastFromMe,
      lastTimestamp: t.lastTimestamp,
      messageCount: t.messageCount,
    }))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

export function getSessionChatMessages(
  sessionId: string,
  chatId: string,
  limit = 100
): LiveChatMessage[] {
  const store = ensureSessionChatsMap();
  const threads = store.get(sessionId);
  const thread = threads?.get(chatId);
  if (!thread) return [];
  const safeLimit = Math.max(1, Math.min(MAX_LIVE_MESSAGES_PER_THREAD, limit));
  return thread.messages.slice(-safeLimit);
}

export function removeSessionChatMessage(
  sessionId: string,
  chatId: string,
  msgId: string
): void {
  const store = ensureSessionChatsMap();
  const thread = store.get(sessionId)?.get(chatId);
  if (!thread) return;
  const idx = thread.messages.findIndex((m) => m.id === msgId);
  if (idx >= 0) {
    thread.messages[idx] = {
      ...thread.messages[idx],
      text: '[Message deleted by admin]',
    };
    const latest = thread.messages[thread.messages.length - 1];
    if (latest) {
      thread.lastMessage = latest.text;
    }
    schedulePersistSnapshot();
  }
}

export function getSessionMessageStats(sessionId: string): {
  chatCount: number;
  messageCount: number;
  lastActivityAt: number;
} {
  const store = ensureSessionChatsMap();
  const threads = store.get(sessionId);
  if (!threads || threads.size === 0) {
    return { chatCount: 0, messageCount: 0, lastActivityAt: 0 };
  }
  let messageCount = 0;
  let lastActivityAt = 0;
  for (const t of threads.values()) {
    messageCount += t.messageCount;
    if (t.lastTimestamp > lastActivityAt) {
      lastActivityAt = t.lastTimestamp;
    }
  }
  return {
    chatCount: threads.size,
    messageCount,
    lastActivityAt,
  };
}

export function clearSessionChatData(sessionId: string): void {
  const store = ensureSessionChatsMap();
  if (store.delete(sessionId)) {
    schedulePersistSnapshot();
  }
}
