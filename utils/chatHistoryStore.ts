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
