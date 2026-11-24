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

export interface PairedUserEntry {
  number: string;
  name: string;
  sessionId: string;
  status: 'connected' | 'offline' | 'logged_out';
  pairingCount: number;
  firstPairedAt: string;
  lastPairedAt: string;
}

export interface MutedUserEntry {
  expiresAt: number;
  reason?: string;
}

export interface AfkUserEntry {
  number: string;
  jid: string;
  name: string;
  reason: string;
  since: number;
}

export interface GroupConfig {
  groupId: string;
  antilink: boolean;
  antilinkMode?: 'off' | 'delete' | 'warn' | 'kick';
  antidelete?: boolean;
  antiScam?: boolean;
  antiStatusMention?: boolean;
  antiAdd?: boolean;
  antiForward?: boolean;
  antiMedia?: boolean;
  antiSticker?: boolean;
  antiBot?: boolean;
  antiPayMsg?: boolean;
  antiAdmin?: boolean;
  antiKickAll?: boolean;
  slowModeSeconds?: number;
  mutedUsers?: Record<string, MutedUserEntry>;
  aiEnabled?: boolean;
  welcome: boolean;
  welcomeImg?: boolean;
  goodbye: boolean;
  warnings?: Record<string, number>;
  antiScamWarnings?: Record<string, number>;
}

export interface CommandTimingRule {
  delaySeconds: number;
  deleteAfterSeconds: number;
}

export interface BannedUserEntry {
  number: string;
  jid: string;
  reason?: string;
  bannedBy?: string;
  bannedAt: string;
}

export interface ProtectedPayMsgPayload {
  currency: string;
  amount1000: number;
  finalText: string;
  linkUrl?: string;
  requestFrom?: string;
}

export interface ProtectedPostEntry {
  msgId: string;
  chatId: string;
  text: string;
  repostCount: number;
  createdAt: number;
  paymsg?: ProtectedPayMsgPayload;
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
let pairedUsersCache: PairedUserEntry[] | null = null;
let groupsCache: Record<string, GroupConfig> | null = null;
let pairingLogsCache: PairingAuditEntry[] | null = null;
let bannedStickersCache: BannedStickerEntry[] | null = null;
let bannedUsersCache: BannedUserEntry[] | null = null;
let protectedPostsCache: Record<string, ProtectedPostEntry> | null = null;
let afkUsersCache: Record<string, AfkUserEntry> | null = null;
let commandTimingsCache: Record<string, CommandTimingRule> | null = null;

registerDbHydrationHook(() => {
  vipsCache = null;
  pairedUsersCache = null;
  groupsCache = null;
  pairingLogsCache = null;
  bannedStickersCache = null;
  bannedUsersCache = null;
  protectedPostsCache = null;
  afkUsersCache = null;
  commandTimingsCache = null;
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

  listPairedUsers(): PairedUserEntry[] {
    if (pairedUsersCache) return [...pairedUsersCache];
    const fromDb = dbGetSync<PairedUserEntry[]>('paired_users') || [];
    pairedUsersCache = Array.isArray(fromDb) ? fromDb : [];
    return [...pairedUsersCache];
  },

  recordConnectedSession(input: {
    number: string;
    name?: string;
    sessionId: string;
    incrementCount?: boolean;
    status?: 'connected' | 'offline';
  }): PairedUserEntry | null {
    const cleaned = normalizePhone(input.number || '');
    if (!cleaned || cleaned.length < 7) return null;

    const list = this.listPairedUsers();
    const nowIso = new Date().toISOString();
    const cleanName = String(input.name || '').trim();
    const nextStatus = input.status || 'connected';

    const idx = list.findIndex((u) => u.number === cleaned);
    if (idx >= 0) {
      const existing = list[idx];
      const updated: PairedUserEntry = {
        ...existing,
        number: cleaned,
        name:
          cleanName && !cleanName.startsWith('+')
            ? cleanName
            : existing.name || cleanName || `+${cleaned}`,
        sessionId: input.sessionId || existing.sessionId,
        status: nextStatus,
        pairingCount: Math.max(
          existing.pairingCount || 0,
          input.incrementCount ? (existing.pairingCount || 0) + 1 : 1
        ),
        lastPairedAt: nextStatus === 'connected' ? nowIso : existing.lastPairedAt || nowIso,
      };
      list[idx] = updated;
      pairedUsersCache = list;
      dbSetSync('paired_users', list);
      return updated;
    }

    const created: PairedUserEntry = {
      number: cleaned,
      name: cleanName || `+${cleaned}`,
      sessionId: input.sessionId,
      status: nextStatus,
      pairingCount: 1,
      firstPairedAt: nowIso,
      lastPairedAt: nowIso,
    };
    list.push(created);
    pairedUsersCache = list;
    dbSetSync('paired_users', list);
    return created;
  },

  markSessionStatus(numberOrSessionId: string, status: 'connected' | 'offline' | 'logged_out'): void {
    const raw = String(numberOrSessionId || '').trim();
    if (!raw) return;
    const cleaned = normalizePhone(raw);
    const list = this.listPairedUsers();
    let changed = false;

    const nextList = list.map((u) => {
      const matchesSession = u.sessionId === raw;
      const matchesPhone = Boolean(cleaned) && u.number === cleaned && raw !== 'main';
      if (!matchesSession && !matchesPhone) return u;
      if (u.status === status) return u;
      changed = true;
      return {
        ...u,
        status,
        lastPairedAt: status === 'connected' ? new Date().toISOString() : u.lastPairedAt,
      };
    });

    if (changed) {
      pairedUsersCache = nextList;
      dbSetSync('paired_users', nextList);
    }
  },

  getCombinedActiveUsers(liveSnapshot?: {
    status?: string;
    connectedUser?: { phone?: string; name?: string } | null;
    subSessions?: Array<{
      phone?: string;
      status?: string;
      connectedUser?: { phone?: string; name?: string };
      createdAt?: string;
    }>;
  }): {
    activePaidUsersCount: number;
    activeVipsCount: number;
    totalPairings: number;
    users: Array<{
      number: string;
      name: string;
      tier: VipTier | 'paired';
      online: boolean;
      pairingCount: number;
      lastPairedAt?: string;
    }>;
  } {
    const vips = this.listVips().filter((v) => v.active);
    const pairedUsers = this.listPairedUsers().filter((u) => u.status !== 'logged_out');

    const merged = new Map<
      string,
      {
        number: string;
        name: string;
        tier: VipTier | 'paired';
        online: boolean;
        pairingCount: number;
        lastPairedAt?: string;
      }
    >();

    for (const vip of vips) {
      const clean = normalizePhone(vip.number);
      if (!clean) continue;
      merged.set(clean, {
        number: clean,
        name: vip.name || `VIP ${clean.slice(-4)}`,
        tier: vip.tier,
        online: false,
        pairingCount: vip.pairingCount || 0,
        lastPairedAt: vip.lastPairedAt,
      });
    }

    for (const paired of pairedUsers) {
      const clean = normalizePhone(paired.number);
      if (!clean) continue;
      const existing = merged.get(clean);
      if (existing) {
        merged.set(clean, {
          ...existing,
          name:
            existing.name && !existing.name.startsWith('+')
              ? existing.name
              : paired.name || existing.name,
          online: existing.online || paired.status === 'connected',
          pairingCount: Math.max(existing.pairingCount, paired.pairingCount || 1),
          lastPairedAt: paired.lastPairedAt || existing.lastPairedAt,
        });
      } else {
        merged.set(clean, {
          number: clean,
          name: paired.name || `+${clean}`,
          tier: 'paired',
          online: paired.status === 'connected',
          pairingCount: paired.pairingCount || 1,
          lastPairedAt: paired.lastPairedAt,
        });
      }
    }

    if (liveSnapshot?.status === 'connected' && liveSnapshot.connectedUser?.phone) {
      const clean = normalizePhone(liveSnapshot.connectedUser.phone);
      if (clean) {
        const existing = merged.get(clean);
        merged.set(clean, {
          number: clean,
          name:
            (existing?.name && !existing.name.startsWith('+') ? existing.name : '') ||
            liveSnapshot.connectedUser.name ||
            existing?.name ||
            `+${clean}`,
          tier: existing?.tier || 'paired',
          online: true,
          pairingCount: Math.max(existing?.pairingCount || 0, 1),
          lastPairedAt: existing?.lastPairedAt || new Date().toISOString(),
        });
      }
    }

    for (const sub of liveSnapshot?.subSessions || []) {
      if (sub.status === 'logged_out' || sub.status === 'disconnected') continue;
      const clean = normalizePhone(sub.connectedUser?.phone || sub.phone || '');
      if (!clean) continue;
      if (sub.status !== 'connected' && !merged.has(clean)) continue;
      const existing = merged.get(clean);
      merged.set(clean, {
        number: clean,
        name:
          (existing?.name && !existing.name.startsWith('+') ? existing.name : '') ||
          sub.connectedUser?.name ||
          existing?.name ||
          `+${clean}`,
        tier: existing?.tier || 'paired',
        online: existing?.online || sub.status === 'connected',
        pairingCount: Math.max(existing?.pairingCount || 0, 1),
        lastPairedAt: existing?.lastPairedAt || sub.createdAt,
      });
    }

    const users = Array.from(merged.values()).sort((a, b) => {
      if (a.tier === 'owner' && b.tier !== 'owner') return -1;
      if (b.tier === 'owner' && a.tier !== 'owner') return 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.lastPairedAt || '').localeCompare(a.lastPairedAt || '');
    });

    const totalPairings = users.reduce((sum, u) => sum + Math.max(u.pairingCount, 0), 0);

    return {
      activePaidUsersCount: users.length,
      activeVipsCount: vips.length,
      totalPairings,
      users,
    };
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
        antiAdd: false,
        antiForward: false,
        antiMedia: false,
        antiSticker: false,
        antiBot: false,
        antiPayMsg: false,
        antiAdmin: false,
        antiKickAll: false,
        slowModeSeconds: 0,
        mutedUsers: {},
        aiEnabled: false,
        welcome: false,
        welcomeImg: false,
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
      antiAdd: Boolean(found.antiAdd),
      antiForward: Boolean(found.antiForward),
      antiMedia: Boolean(found.antiMedia),
      antiSticker: Boolean(found.antiSticker),
      antiBot: Boolean(found.antiBot),
      antiPayMsg: Boolean(found.antiPayMsg),
      antiAdmin: Boolean(found.antiAdmin),
      antiKickAll: Boolean(found.antiKickAll),
      slowModeSeconds: Math.max(0, Number(found.slowModeSeconds || 0)),
      mutedUsers: found.mutedUsers || {},
      aiEnabled: Boolean(found.aiEnabled),
      welcome: Boolean(found.welcome),
      welcomeImg: Boolean(found.welcomeImg),
      goodbye: Boolean(found.goodbye),
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
      antiAdd: Boolean(g.antiAdd),
      antiForward: Boolean(g.antiForward),
      antiMedia: Boolean(g.antiMedia),
      antiSticker: Boolean(g.antiSticker),
      antiBot: Boolean(g.antiBot),
      antiPayMsg: Boolean(g.antiPayMsg),
      antiAdmin: Boolean(g.antiAdmin),
      antiKickAll: Boolean(g.antiKickAll),
      slowModeSeconds: Math.max(0, Number(g.slowModeSeconds || 0)),
      mutedUsers: g.mutedUsers || {},
      aiEnabled: Boolean(g.aiEnabled),
      welcome: Boolean(g.welcome),
      welcomeImg: Boolean(g.welcomeImg),
      goodbye: Boolean(g.goodbye),
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
    if (typeof patch.antiAdd === 'boolean') cleanPatch.antiAdd = patch.antiAdd;
    if (typeof patch.antiForward === 'boolean') cleanPatch.antiForward = patch.antiForward;
    if (typeof patch.antiMedia === 'boolean') cleanPatch.antiMedia = patch.antiMedia;
    if (typeof patch.antiSticker === 'boolean') cleanPatch.antiSticker = patch.antiSticker;
    if (typeof patch.antiBot === 'boolean') cleanPatch.antiBot = patch.antiBot;
    if (typeof patch.antiPayMsg === 'boolean') cleanPatch.antiPayMsg = patch.antiPayMsg;
    if (typeof patch.antiAdmin === 'boolean') cleanPatch.antiAdmin = patch.antiAdmin;
    if (typeof patch.antiKickAll === 'boolean') cleanPatch.antiKickAll = patch.antiKickAll;
    if (typeof patch.slowModeSeconds === 'number' && Number.isFinite(patch.slowModeSeconds)) {
      cleanPatch.slowModeSeconds = Math.max(0, Math.min(3600, Math.floor(patch.slowModeSeconds)));
    }
    if (patch.mutedUsers && typeof patch.mutedUsers === 'object') {
      cleanPatch.mutedUsers = patch.mutedUsers;
    }
    if (typeof patch.aiEnabled === 'boolean') cleanPatch.aiEnabled = patch.aiEnabled;
    if (typeof patch.welcome === 'boolean') cleanPatch.welcome = patch.welcome;
    if (typeof patch.welcomeImg === 'boolean') cleanPatch.welcomeImg = patch.welcomeImg;
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

  resetGroupConfig(groupId: string): GroupConfig {
    const groups = { ...readGroupsMap() };
    const cfg = loadConfig();
    const defaults: GroupConfig = {
      groupId,
      antilink: false,
      antilinkMode: 'off',
      antidelete: false,
      antiScam: cfg.antiScamGlobal,
      antiStatusMention: cfg.antiStatusMentionGlobal,
      antiAdd: false,
      antiForward: false,
      antiMedia: false,
      antiSticker: false,
      antiBot: false,
      antiPayMsg: false,
      antiAdmin: false,
      antiKickAll: false,
      slowModeSeconds: 0,
      mutedUsers: {},
      aiEnabled: false,
      welcome: false,
      welcomeImg: false,
      goodbye: false,
      warnings: {},
      antiScamWarnings: {},
    };
    groups[groupId] = defaults;
    groupsCache = groups;
    dbSetSync('groups', groups);
    return defaults;
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

  registerProtectedPost(
    msgId: string,
    chatId: string,
    text: string,
    repostCount = 0,
    paymsg?: ProtectedPayMsgPayload
  ): void {
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
      ...(paymsg ? { paymsg } : {}),
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

  removeProtectedPost(chatId: string, msgId: string): void {
    if (!msgId || !chatId) return;
    if (!protectedPostsCache) {
      protectedPostsCache = dbGetSync<Record<string, ProtectedPostEntry>>('protected_posts') || {};
    }
    const key = `${chatId}:${msgId}`;
    if (protectedPostsCache[key]) {
      delete protectedPostsCache[key];
      dbSetSync('protected_posts', protectedPostsCache);
    }
  },

  setAfkUser(input: { number: string; jid: string; name: string; reason: string }): AfkUserEntry {
    if (!afkUsersCache) {
      afkUsersCache = dbGetSync<Record<string, AfkUserEntry>>('afk_users') || {};
    }
    const cleanNum = normalizePhone(input.number) || input.number;
    const entry: AfkUserEntry = {
      number: cleanNum,
      jid: input.jid,
      name: input.name || `+${cleanNum}`,
      reason: input.reason.trim() || 'Busy right now',
      since: Date.now(),
    };
    afkUsersCache[cleanNum] = entry;
    dbSetSync('afk_users', afkUsersCache);
    return entry;
  },

  clearAfkUser(numberOrJid: string): AfkUserEntry | null {
    if (!afkUsersCache) {
      afkUsersCache = dbGetSync<Record<string, AfkUserEntry>>('afk_users') || {};
    }
    const clean = normalizePhone(numberOrJid) || numberOrJid.split('@')[0].split(':')[0];
    const existing = afkUsersCache[clean] || null;
    if (!existing) {
      const byJid = Object.values(afkUsersCache).find((a) => a.jid === numberOrJid);
      if (!byJid) return null;
      delete afkUsersCache[byJid.number];
      dbSetSync('afk_users', afkUsersCache);
      return byJid;
    }
    delete afkUsersCache[clean];
    dbSetSync('afk_users', afkUsersCache);
    return existing;
  },

  findAfkUser(candidates: string[]): AfkUserEntry | null {
    if (!afkUsersCache) {
      afkUsersCache = dbGetSync<Record<string, AfkUserEntry>>('afk_users') || {};
    }
    for (const raw of candidates) {
      if (!raw) continue;
      const clean = normalizePhone(raw.split('@')[0].split(':')[0]);
      if (clean && afkUsersCache[clean]) return afkUsersCache[clean];
      const byJid = Object.values(afkUsersCache).find((a) => a.jid === raw);
      if (byJid) return byJid;
    }
    return null;
  },

  listBannedUsers(): BannedUserEntry[] {
    if (!bannedUsersCache) {
      const fromDb = dbGetSync<BannedUserEntry[]>('banned_users') || [];
      bannedUsersCache = Array.isArray(fromDb) ? fromDb : [];
    }
    return [...bannedUsersCache];
  },

  isUserBanned(candidates: string[]): BannedUserEntry | null {
    const list = this.listBannedUsers();
    if (list.length === 0) return null;
    for (const raw of candidates) {
      if (!raw) continue;
      const bare = raw.split('@')[0].split(':')[0];
      const clean = normalizePhone(bare);
      const hit = list.find(
        (b) =>
          (clean && b.number === clean) ||
          b.number === bare ||
          b.jid === raw ||
          b.jid.split('@')[0].split(':')[0] === bare
      );
      if (hit) return hit;
    }
    return null;
  },

  banUser(input: {
    number: string;
    jid?: string;
    reason?: string;
    bannedBy?: string;
  }): BannedUserEntry {
    const bare = String(input.number || input.jid || '').split('@')[0].split(':')[0];
    const cleanNum = normalizePhone(bare) || bare;
    const jid = input.jid || (cleanNum ? `${cleanNum}@s.whatsapp.net` : bare);
    const list = this.listBannedUsers().filter(
      (b) => b.number !== cleanNum && b.jid !== jid
    );
    const entry: BannedUserEntry = {
      number: cleanNum,
      jid,
      reason: input.reason?.trim() || undefined,
      bannedBy: input.bannedBy?.trim() || undefined,
      bannedAt: new Date().toISOString(),
    };
    list.unshift(entry);
    if (list.length > 1000) list.length = 1000;
    bannedUsersCache = list;
    dbSetSync('banned_users', list);
    return entry;
  },

  unbanUser(candidates: string[]): BannedUserEntry | null {
    const match = this.isUserBanned(candidates);
    if (!match) return null;
    const list = this.listBannedUsers().filter(
      (b) => b.number !== match.number && b.jid !== match.jid
    );
    bannedUsersCache = list;
    dbSetSync('banned_users', list);
    return match;
  },

  getCommandTimings(): Record<string, CommandTimingRule> {
    if (!commandTimingsCache) {
      const fromDb = dbGetSync<Record<string, CommandTimingRule>>('command_timings') || {};
      commandTimingsCache = fromDb && typeof fromDb === 'object' ? { ...fromDb } : {};
    }
    return { ...commandTimingsCache };
  },

  getCommandTiming(commandName: string): CommandTimingRule {
    const key = String(commandName || '').trim().toLowerCase();
    if (!key) return { delaySeconds: 0, deleteAfterSeconds: 0 };
    const map = this.getCommandTimings();
    const rule = map[key];
    return {
      delaySeconds: Math.max(0, Math.min(300, Math.floor(Number(rule?.delaySeconds || 0)))),
      deleteAfterSeconds: Math.max(
        0,
        Math.min(86400, Math.floor(Number(rule?.deleteAfterSeconds || 0)))
      ),
    };
  },

  setCommandTiming(
    commandName: string,
    patch: Partial<CommandTimingRule>
  ): CommandTimingRule {
    const key = String(commandName || '').trim().toLowerCase();
    const map = this.getCommandTimings();
    const current = this.getCommandTiming(key);
    const delaySeconds =
      typeof patch.delaySeconds === 'number' && Number.isFinite(patch.delaySeconds)
        ? Math.max(0, Math.min(300, Math.floor(patch.delaySeconds)))
        : current.delaySeconds;
    const deleteAfterSeconds =
      typeof patch.deleteAfterSeconds === 'number' && Number.isFinite(patch.deleteAfterSeconds)
        ? Math.max(0, Math.min(86400, Math.floor(patch.deleteAfterSeconds)))
        : current.deleteAfterSeconds;
    const next: CommandTimingRule = { delaySeconds, deleteAfterSeconds };
    if (key) {
      if (next.delaySeconds === 0 && next.deleteAfterSeconds === 0) {
        delete map[key];
      } else {
        map[key] = next;
      }
      commandTimingsCache = map;
      dbSetSync('command_timings', map);
    }
    return next;
  },

  setBulkCommandTimings(
    commandNames: string[],
    patch: Partial<CommandTimingRule>
  ): Record<string, CommandTimingRule> {
    const map = this.getCommandTimings();
    for (const raw of commandNames) {
      const key = String(raw || '').trim().toLowerCase();
      if (!key) continue;
      const current = map[key] || { delaySeconds: 0, deleteAfterSeconds: 0 };
      const delaySeconds =
        typeof patch.delaySeconds === 'number' && Number.isFinite(patch.delaySeconds)
          ? Math.max(0, Math.min(300, Math.floor(patch.delaySeconds)))
          : Math.max(0, Math.min(300, Math.floor(Number(current.delaySeconds || 0))));
      const deleteAfterSeconds =
        typeof patch.deleteAfterSeconds === 'number' && Number.isFinite(patch.deleteAfterSeconds)
          ? Math.max(0, Math.min(86400, Math.floor(patch.deleteAfterSeconds)))
          : Math.max(0, Math.min(86400, Math.floor(Number(current.deleteAfterSeconds || 0))));

      if (delaySeconds === 0 && deleteAfterSeconds === 0) {
        delete map[key];
      } else {
        map[key] = { delaySeconds, deleteAfterSeconds };
      }
    }
    commandTimingsCache = map;
    dbSetSync('command_timings', map);
    return { ...map };
  },
};
