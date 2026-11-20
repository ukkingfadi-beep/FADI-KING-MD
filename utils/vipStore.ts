import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import {
  dbGetSync,
  dbSetSync,
  migrateLegacyJsonIfMissing,
  registerDbHydrationHook,
  resolveDataDir,
} from './db.ts';

export type VipTier = 'owner' | 'diamond' | 'gold';

export interface VipUser {
  number: string;
  name: string;
  tier: VipTier;
  token: string;
  addedBy: string;
  addedAt: string;
  pairingCount: number;
  lastPairedAt?: string;
  active: boolean;
}

export interface GroupConfig {
  groupId: string;
  antilink: boolean;
  antilinkMode?: 'off' | 'delete' | 'warn' | 'kick';
  antidelete?: boolean;
  antiScam?: boolean;
  antiStatusMention?: boolean;
  welcome: boolean;
  goodbye: boolean;
  warnings?: Record<string, number>;
  antiScamWarnings?: Record<string, number>;
}

export interface ProtectedPostEntry {
  msgId: string;
  chatId: string;
  text: string;
  repostCount: number;
  createdAt: number;
}

export interface BannedStickerEntry {
  sha256: string;
  label?: string;
  addedAt: string;
}

export interface PairingAuditEntry {
  id: string;
  number: string;
  status: 'authorized' | 'denied' | 'rate_limited' | 'error';
  reason: string;
  codePreview?: string;
  source: 'dashboard' | 'whatsapp_cmd';
  timestamp: string;
}

const dbDir = resolveDataDir();
const vipFile = path.join(dbDir, 'vip.json');
const groupsFile = path.join(dbDir, 'groups.json');
const pairingLogsFile = path.join(dbDir, 'pairing_logs.json');

let vipsCache: VipUser[] | null = null;
let groupsCache: Record<string, GroupConfig> | null = null;
let pairingLogsCache: PairingAuditEntry[] | null = null;
let bannedStickersCache: BannedStickerEntry[] | null = null;
let protectedPostsCache: Record<string, ProtectedPostEntry> | null = null;

registerDbHydrationHook(() => {
  vipsCache = null;
  groupsCache = null;
  pairingLogsCache = null;
  bannedStickersCache = null;
  protectedPostsCache = null;
});

function readStoreKey<T>(key: string, legacyPath: string, fallback: T): T {
  const fromDb = dbGetSync<T>(key) ?? migrateLegacyJsonIfMissing<T>(key, legacyPath);
  if (fromDb !== null) return fromDb;
  dbSetSync(key, fallback);
  return fallback;
}

function generateVipToken(): string {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `FKMD-${random.slice(0, 4)}-${random.slice(4, 8)}`;
}

function getDefaultVips(): VipUser[] {
  const cfg = loadConfig();
  return [
    {
      number: cfg.ownerNumber,
      name: cfg.ownerName || 'FADI KING',
      tier: 'owner',
      token: 'FKMD-KING-0001',
      addedBy: 'system',
      addedAt: new Date().toISOString(),
      pairingCount: 0,
      active: true,
    },
  ];
}

function readGroupsMap(): Record<string, GroupConfig> {
  if (groupsCache) return groupsCache;
  groupsCache = readStoreKey<Record<string, GroupConfig>>('groups', groupsFile, {});
  return groupsCache;
}

export const vipStore = {
  listVips(): VipUser[] {
    if (vipsCache) return vipsCache;
    const vips = readStoreKey<VipUser[]>('vips', vipFile, getDefaultVips());
    const cfg = loadConfig();
    const hasOwner = vips.some((v) => v.number === cfg.ownerNumber);
    if (!hasOwner && cfg.ownerNumber) {
      vips.unshift({
        number: cfg.ownerNumber,
        name: cfg.ownerName || 'FADI KING',
        tier: 'owner',
        token: 'FKMD-KING-0001',
        addedBy: 'system',
        addedAt: new Date().toISOString(),
        pairingCount: 0,
        active: true,
      });
      dbSetSync('vips', vips);
    }
    vipsCache = vips;
    return vips;
  },

  findVip(numberOrToken: string): VipUser | undefined {
    const cleaned = normalizePhone(numberOrToken);
    const trimmed = numberOrToken.trim().toUpperCase();
    return this.listVips().find(
      (v) => v.active && (v.number === cleaned || v.token.toUpperCase() === trimmed)
    );
  },

  isOwner(number: string): boolean {
    const cfg = loadConfig();
    const cleaned = normalizePhone(number);
    if (cleaned === cfg.ownerNumber) return true;
    const found = this.findVip(cleaned);
    return found?.tier === 'owner';
  },

  isVip(number: string): boolean {
    const cleaned = normalizePhone(number);
    return Boolean(this.findVip(cleaned));
  },

  isAuthorizedForPairing(targetNumber: string, accessToken?: string): { authorized: boolean; vip?: VipUser; reason: string } {
    const cfg = loadConfig();
    const cleaned = normalizePhone(targetNumber);

    if (!cfg.vipOnlyPairing) {
      return { authorized: true, reason: 'Open pairing mode active' };
    }

    const byNumber = this.findVip(cleaned);
    if (byNumber) {
      return { authorized: true, vip: byNumber, reason: `Verified ${byNumber.tier.toUpperCase()} VIP number` };
    }

    if (accessToken && accessToken.trim()) {
      const byToken = this.findVip(accessToken.trim());
      if (byToken) {
        return { authorized: true, vip: byToken, reason: `Verified via VIP Token (${byToken.tier.toUpperCase()})` };
      }
    }

    return {
      authorized: false,
      reason: `This number (+${cleaned}) is not on the FADI KING MD VIP whitelist. Enter an FKMD VIP Token or add it in Admin Panel → VIP Access.`,
    };
  },

  addVip(input: { number: string; name?: string; tier?: VipTier; addedBy?: string }): VipUser {
    const cleaned = normalizePhone(input.number);
    const vips = [...this.listVips()];
    const existingIndex = vips.findIndex((v) => v.number === cleaned);
    if (existingIndex >= 0) {
      vips[existingIndex] = {
        ...vips[existingIndex],
        name: input.name || vips[existingIndex].name,
        tier: input.tier || vips[existingIndex].tier,
        active: true,
      };
      vipsCache = vips;
      dbSetSync('vips', vips);
      return vips[existingIndex];
    }

    const created: VipUser = {
      number: cleaned,
      name: input.name?.trim() || `VIP ${cleaned.slice(-4)}`,
      tier: input.tier || 'gold',
      token: generateVipToken(),
      addedBy: input.addedBy || 'owner',
      addedAt: new Date().toISOString(),
      pairingCount: 0,
      active: true,
    };
    vips.push(created);
    vipsCache = vips;
    dbSetSync('vips', vips);
    return created;
  },

  removeVip(number: string): { removed: boolean; reason?: string } {
    const cfg = loadConfig();
    const cleaned = normalizePhone(number);
    if (cleaned === cfg.ownerNumber) {
      return { removed: false, reason: 'Primary owner cannot be removed from VIP list.' };
    }
    const vips = this.listVips();
    const filtered = vips.filter((v) => v.number !== cleaned);
    if (filtered.length === vips.length) {
      return { removed: false, reason: 'Number not found in VIP list.' };
    }
    vipsCache = filtered;
    dbSetSync('vips', filtered);
    return { removed: true };
  },

  recordPairingSuccess(number: string): void {
    const cleaned = normalizePhone(number);
    const vips = [...this.listVips()];
    const idx = vips.findIndex((v) => v.number === cleaned);
    if (idx >= 0) {
      vips[idx] = {
        ...vips[idx],
        pairingCount: vips[idx].pairingCount + 1,
        lastPairedAt: new Date().toISOString(),
      };
      vipsCache = vips;
      dbSetSync('vips', vips);
    }
  },

  getGroupConfig(groupId: string): GroupConfig {
    const groups = readGroupsMap();
    const found = groups[groupId];
    const cfg = loadConfig();
    if (!found) {
      return {
        groupId,
        antilink: false,
        antilinkMode: 'off',
        antidelete: false,
        antiScam: cfg.antiScamGlobal,
        antiStatusMention: cfg.antiStatusMentionGlobal,
        welcome: true,
        goodbye: false,
      };
    }
    return {
      ...found,
      antilinkMode: found.antilinkMode || (found.antilink ? 'delete' : 'off'),
      antidelete: Boolean(found.antidelete),
      antiScam: typeof found.antiScam === 'boolean' ? found.antiScam : cfg.antiScamGlobal,
      antiStatusMention:
        typeof found.antiStatusMention === 'boolean'
          ? found.antiStatusMention
          : cfg.antiStatusMentionGlobal,
    };
  },

  listGroupConfigs(): GroupConfig[] {
    const cfg = loadConfig();
    return Object.values(readGroupsMap()).map((g) => ({
      ...g,
      antilinkMode: g.antilinkMode || (g.antilink ? 'delete' : 'off'),
      antidelete: Boolean(g.antidelete),
      antiScam: typeof g.antiScam === 'boolean' ? g.antiScam : cfg.antiScamGlobal,
      antiStatusMention:
        typeof g.antiStatusMention === 'boolean'
          ? g.antiStatusMention
          : cfg.antiStatusMentionGlobal,
    }));
  },

  updateGroupConfig(groupId: string, patch: Partial<Omit<GroupConfig, 'groupId'>>): GroupConfig {
    const groups = { ...readGroupsMap() };
    const current = this.getGroupConfig(groupId);
    const cleanPatch: Partial<Omit<GroupConfig, 'groupId'>> = {};
    if (typeof patch.antilink === 'boolean') cleanPatch.antilink = patch.antilink;
    if (
      patch.antilinkMode === 'off' ||
      patch.antilinkMode === 'delete' ||
      patch.antilinkMode === 'warn' ||
      patch.antilinkMode === 'kick'
    ) {
      cleanPatch.antilinkMode = patch.antilinkMode;
      cleanPatch.antilink = patch.antilinkMode !== 'off';
    } else if (typeof patch.antilink === 'boolean' && patch.antilinkMode === undefined) {
      cleanPatch.antilinkMode = patch.antilink
        ? current.antilinkMode !== 'off'
          ? current.antilinkMode
          : 'delete'
        : 'off';
    }
    if (typeof patch.antidelete === 'boolean') cleanPatch.antidelete = patch.antidelete;
    if (typeof patch.antiScam === 'boolean') cleanPatch.antiScam = patch.antiScam;
    if (typeof patch.antiStatusMention === 'boolean') {
      cleanPatch.antiStatusMention = patch.antiStatusMention;
    }
    if (typeof patch.welcome === 'boolean') cleanPatch.welcome = patch.welcome;
    if (typeof patch.goodbye === 'boolean') cleanPatch.goodbye = patch.goodbye;
    if (patch.warnings && typeof patch.warnings === 'object') cleanPatch.warnings = patch.warnings;
    if (patch.antiScamWarnings && typeof patch.antiScamWarnings === 'object') {
      cleanPatch.antiScamWarnings = patch.antiScamWarnings;
    }

    const updated: GroupConfig = { ...current, ...cleanPatch, groupId };
    groups[groupId] = updated;
    groupsCache = groups;
    dbSetSync('groups', groups);
    return updated;
  },

  listBannedStickers(): BannedStickerEntry[] {
    if (!bannedStickersCache) {
      bannedStickersCache = dbGetSync<BannedStickerEntry[]>('banned_stickers') || [];
    }
    return [...bannedStickersCache];
  },

  isStickerBanned(sha256: string): boolean {
    if (!sha256) return false;
    return this.listBannedStickers().some((s) => s.sha256 === sha256);
  },

  banSticker(sha256: string, label?: string): BannedStickerEntry {
    const list = this.listBannedStickers().filter((s) => s.sha256 !== sha256);
    const entry: BannedStickerEntry = {
      sha256,
      label: label?.trim() || 'Blocked Sticker',
      addedAt: new Date().toISOString(),
    };
    list.unshift(entry);
    if (list.length > 500) list.length = 500;
    bannedStickersCache = list;
    dbSetSync('banned_stickers', list);
    return entry;
  },

  unbanSticker(sha256: string): boolean {
    const list = this.listBannedStickers();
    const filtered = list.filter((s) => s.sha256 !== sha256);
    if (filtered.length === list.length) return false;
    bannedStickersCache = filtered;
    dbSetSync('banned_stickers', filtered);
    return true;
  },

  logPairingAttempt(entry: Omit<PairingAuditEntry, 'id' | 'timestamp'>): PairingAuditEntry {
    if (!pairingLogsCache) {
      pairingLogsCache = readStoreKey<PairingAuditEntry[]>('pairing_logs', pairingLogsFile, []);
    }
    const created: PairingAuditEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    pairingLogsCache.unshift(created);
    if (pairingLogsCache.length > 150) pairingLogsCache.length = 150;
    dbSetSync('pairing_logs', pairingLogsCache);
    return created;
  },

  getPairingLogs(limit = 30): PairingAuditEntry[] {
    if (!pairingLogsCache) {
      pairingLogsCache = readStoreKey<PairingAuditEntry[]>('pairing_logs', pairingLogsFile, []);
    }
    return pairingLogsCache.slice(0, limit);
  },

  registerProtectedPost(msgId: string, chatId: string, text: string, repostCount = 0): void {
    if (!msgId || !chatId || !text) return;
    if (!protectedPostsCache) {
      protectedPostsCache = dbGetSync<Record<string, ProtectedPostEntry>>('protected_posts') || {};
    }
    protectedPostsCache[`${chatId}:${msgId}`] = {
      msgId,
      chatId,
      text,
      repostCount,
      createdAt: Date.now(),
    };
    const keys = Object.keys(protectedPostsCache);
    if (keys.length > 400) {
      keys
        .sort((a, b) => protectedPostsCache![a].createdAt - protectedPostsCache![b].createdAt)
        .slice(0, keys.length - 400)
        .forEach((k) => {
          delete protectedPostsCache![k];
        });
    }
    dbSetSync('protected_posts', protectedPostsCache);
  },

  consumeProtectedPost(chatId: string, msgId: string): ProtectedPostEntry | null {
    if (!msgId || !chatId) return null;
    if (!protectedPostsCache) {
      protectedPostsCache = dbGetSync<Record<string, ProtectedPostEntry>>('protected_posts') || {};
    }
    const key = `${chatId}:${msgId}`;
    const entry = protectedPostsCache[key];
    if (!entry) return null;
    delete protectedPostsCache[key];
    dbSetSync('protected_posts', protectedPostsCache);
    return entry;
  },
};
