import path from 'path';
import { normalizePhone } from '../config/bot.config.ts';
import {
  dbGetSync,
  dbSetSync,
  migrateLegacyJsonIfMissing,
  registerDbHydrationHook,
  resolveDataDir,
} from './db.ts';
import { jidUserPart, normalizeBareJid } from './jidHelper.ts';

export interface BlockedCallerEntry {
  jid: string;
  phone: string;
  label?: string;
  addedAt: string;
}

const anticallFile = path.join(resolveDataDir(), 'anticall.json');

let cache: BlockedCallerEntry[] | null = null;
registerDbHydrationHook(() => {
  cache = null;
});

function readEntries(): BlockedCallerEntry[] {
  if (cache) return cache;
  const fromDb =
    dbGetSync<BlockedCallerEntry[]>('anticall') ??
    migrateLegacyJsonIfMissing<BlockedCallerEntry[]>('anticall', anticallFile);
  if (Array.isArray(fromDb)) {
    cache = fromDb;
    return cache;
  }
  cache = [];
  dbSetSync('anticall', cache);
  return cache;
}

function writeEntries(entries: BlockedCallerEntry[]): void {
  cache = entries;
  dbSetSync('anticall', entries);
}

function entryMatchesCandidate(entry: BlockedCallerEntry, rawCandidate: string): boolean {
  const bare = normalizeBareJid(rawCandidate);
  const user = jidUserPart(bare);
  const phone = normalizePhone(rawCandidate);
  if (bare && entry.jid === bare) return true;
  if (entry.phone && ((phone && entry.phone === phone) || (user && entry.phone === user))) return true;
  if (user && jidUserPart(entry.jid) === user) return true;
  return false;
}

export const anticallStore = {
  listBlocked(): BlockedCallerEntry[] {
    return [...readEntries()];
  },

  isBlocked(candidates: string[]): boolean {
    const entries = readEntries();
    return entries.some((entry) => candidates.some((c) => entryMatchesCandidate(entry, c)));
  },

  shouldRejectCall(candidates: string[], globalEnabled: boolean): { reject: boolean; reason: 'global' | 'per_chat' | null } {
    if (globalEnabled) {
      return { reject: true, reason: 'global' };
    }
    if (this.isBlocked(candidates)) {
      return { reject: true, reason: 'per_chat' };
    }
    return { reject: false, reason: null };
  },

  blockCaller(jid: string, phone?: string, label?: string): BlockedCallerEntry {
    const bare = normalizeBareJid(jid);
    const cleanPhone = normalizePhone(phone || jidUserPart(bare));
    const entries = [...readEntries()];
    const existingIdx = entries.findIndex(
      (e) => entryMatchesCandidate(e, bare) || (cleanPhone && entryMatchesCandidate(e, cleanPhone))
    );
    const next: BlockedCallerEntry = {
      jid: bare || `${cleanPhone}@s.whatsapp.net`,
      phone: cleanPhone,
      label: label?.trim() || (existingIdx >= 0 ? entries[existingIdx].label : undefined),
      addedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      entries[existingIdx] = next;
    } else {
      entries.unshift(next);
    }
    writeEntries(entries);
    return next;
  },

  unblockCaller(candidates: string[]): boolean {
    const entries = readEntries();
    const filtered = entries.filter(
      (entry) => !candidates.some((c) => entryMatchesCandidate(entry, c))
    );
    if (filtered.length === entries.length) {
      return false;
    }
    writeEntries(filtered);
    return true;
  },
};
