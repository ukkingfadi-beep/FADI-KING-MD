import fs from 'fs';
import path from 'path';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import { jidUserPart, normalizeBareJid } from './jidHelper.ts';

export interface BlockedCallerEntry {
  jid: string;
  phone: string;
  label?: string;
  addedAt: string;
}

const dbDir = loadConfig().databaseDir;
const anticallFile = path.join(dbDir, 'anticall.json');

let cache: BlockedCallerEntry[] | null = null;

function readEntries(): BlockedCallerEntry[] {
  if (cache && fs.existsSync(anticallFile)) {
    return cache;
  }
  fs.mkdirSync(path.dirname(anticallFile), { recursive: true });
  if (!fs.existsSync(anticallFile)) {
    fs.writeFileSync(anticallFile, JSON.stringify([], null, 2), 'utf-8');
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(anticallFile, 'utf-8')) as BlockedCallerEntry[];
    cache = Array.isArray(parsed) ? parsed : [];
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

function writeEntries(entries: BlockedCallerEntry[]): void {
  cache = entries;
  fs.mkdirSync(path.dirname(anticallFile), { recursive: true });
  fs.writeFileSync(anticallFile, JSON.stringify(entries, null, 2), 'utf-8');
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
