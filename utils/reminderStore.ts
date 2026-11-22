import { dbGetSync, dbSetSync, registerDbHydrationHook } from './db.ts';
import { logger } from './logger.ts';

export interface ReminderEntry {
  id: string;
  chatId: string;
  userJid: string;
  userNumber: string;
  text: string;
  createdAt: number;
  triggerAt: number;
}

let remindersCache: ReminderEntry[] | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerDispatcher:
  | ((chatId: string, text: string, mentions: string[]) => Promise<boolean>)
  | null = null;

registerDbHydrationHook(() => {
  remindersCache = null;
});

function loadReminders(): ReminderEntry[] {
  if (remindersCache) return remindersCache;
  const fromDb = dbGetSync<ReminderEntry[]>('reminders');
  remindersCache = Array.isArray(fromDb) ? fromDb : [];
  return remindersCache;
}

function saveReminders(list: ReminderEntry[]): void {
  remindersCache = list;
  dbSetSync('reminders', list);
}

export function parseDurationMs(raw: string): number | null {
  const match = String(raw || '')
    .trim()
    .toLowerCase()
    .match(/^(\d+)(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let mult = 1000;
  if (unit.startsWith('m')) mult = 60_000;
  else if (unit.startsWith('h')) mult = 3_600_000;
  else if (unit.startsWith('d')) mult = 86_400_000;

  const total = amount * mult;
  const MAX_MS = 30 * 86_400_000; // Cap at 30 days
  return total > MAX_MS ? MAX_MS : total;
}

export function formatDurationHuman(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ') || '1s';
}

export function addReminder(input: {
  chatId: string;
  userJid: string;
  userNumber: string;
  text: string;
  delayMs: number;
}): ReminderEntry {
  const list = [...loadReminders()];
  const now = Date.now();
  const entry: ReminderEntry = {
    id: `rem_${now}_${Math.random().toString(36).slice(2, 7)}`,
    chatId: input.chatId,
    userJid: input.userJid,
    userNumber: input.userNumber,
    text: input.text.trim().slice(0, 500),
    createdAt: now,
    triggerAt: now + input.delayMs,
  };
  list.push(entry);
  if (list.length > 500) {
    list.sort((a, b) => a.triggerAt - b.triggerAt);
    list.splice(0, list.length - 500);
  }
  saveReminders(list);
  return entry;
}

export function listReminders(): ReminderEntry[] {
  return [...loadReminders()];
}

export function startReminderScheduler(
  dispatcher: (chatId: string, text: string, mentions: string[]) => Promise<boolean>
): void {
  schedulerDispatcher = dispatcher;
  if (schedulerTimer) return;

  schedulerTimer = setInterval(() => {
    if (!schedulerDispatcher) return;
    const now = Date.now();
    const list = loadReminders();
    const due = list.filter((r) => r.triggerAt <= now);
    if (due.length === 0) return;

    const remaining = list.filter((r) => r.triggerAt > now);
    saveReminders(remaining);

    void (async () => {
      for (const rem of due) {
        try {
          const mentionTag = rem.userNumber ? `@${rem.userNumber}` : 'User';
          const body = `⏰ *Reminder* for ${mentionTag}\n\n${rem.text}`;
          await schedulerDispatcher!(rem.chatId, body, [rem.userJid]);
        } catch (err) {
          logger.warn('reminder', `Failed dispatching reminder ${rem.id}: ${(err as Error).message}`);
        }
      }
    })();
  }, 5_000);

  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}
