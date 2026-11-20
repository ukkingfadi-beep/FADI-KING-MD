import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';

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
  welcome: boolean;
  goodbye: boolean;
  warnings?: Record<string, number>;
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

const dbDir = loadConfig().databaseDir;
const vipFile = path.join(dbDir, 'vip.json');
const groupsFile = path.join(dbDir, 'groups.json');
const pairingLogsFile = path.join(dbDir, 'pairing_logs.json');

let vipsCache: VipUser[] | null = null;
let groupsCache: Record<string, GroupConfig> | null = null;
let pairingLogsCache: PairingAuditEntry[] | null = null;
const pendingWriteTimers = new Map<string, NodeJS.Timeout>();

function scheduleDebouncedWrite(filePath: string, getData: () => unknown, delayMs = 200): void {
  const existing = pendingWriteTimers.get(filePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingWriteTimers.delete(filePath);
    void fs.promises
      .mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.promises.writeFile(filePath, JSON.stringify(getData(), null, 2), 'utf-8'))
      .catch(() => {});
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  pendingWriteTimers.set(filePath, timer);
}

function ensureJsonFile<T>(filePath: string, fallback: T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf-8');
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
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
  if (groupsCache && fs.existsSync(groupsFile)) {
    return groupsCache;
  }
  groupsCache = ensureJsonFile<Record<string, GroupConfig>>(groupsFile, {});
  return groupsCache;
}

export const vipStore = {
  listVips(): VipUser[] {
    if (vipsCache && fs.existsSync(vipFile)) {
      return vipsCache;
    }
    const vips = ensureJsonFile<VipUser[]>(vipFile, getDefaultVips());
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
      fs.writeFileSync(vipFile, JSON.stringify(vips, null, 2), 'utf-8');
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
      fs.writeFileSync(vipFile, JSON.stringify(vips, null, 2), 'utf-8');
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
    fs.writeFileSync(vipFile, JSON.stringify(vips, null, 2), 'utf-8');
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
    fs.writeFileSync(vipFile, JSON.stringify(filtered, null, 2), 'utf-8');
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
      scheduleDebouncedWrite(vipFile, () => vipsCache || []);
    }
  },

  getGroupConfig(groupId: string): GroupConfig {
    const groups = readGroupsMap();
    const found = groups[groupId];
    if (!found) {
      return {
        groupId,
        antilink: false,
        antilinkMode: 'off',
        antidelete: false,
        welcome: true,
        goodbye: false,
      };
    }
    return {
      ...found,
      antilinkMode: found.antilinkMode || (found.antilink ? 'delete' : 'off'),
      antidelete: Boolean(found.antidelete),
    };
  },

  listGroupConfigs(): GroupConfig[] {
    return Object.values(readGroupsMap()).map((g) => ({
      ...g,
      antilinkMode: g.antilinkMode || (g.antilink ? 'delete' : 'off'),
      antidelete: Boolean(g.antidelete),
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
      cleanPatch.antilinkMode = patch.antilink ? (current.antilinkMode !== 'off' ? current.antilinkMode : 'delete') : 'off';
    }
    if (typeof patch.antidelete === 'boolean') cleanPatch.antidelete = patch.antidelete;
    if (typeof patch.welcome === 'boolean') cleanPatch.welcome = patch.welcome;
    if (typeof patch.goodbye === 'boolean') cleanPatch.goodbye = patch.goodbye;
    if (patch.warnings && typeof patch.warnings === 'object') cleanPatch.warnings = patch.warnings;

    const updated: GroupConfig = { ...current, ...cleanPatch, groupId };
    groups[groupId] = updated;
    groupsCache = groups;
    fs.mkdirSync(path.dirname(groupsFile), { recursive: true });
    fs.writeFileSync(groupsFile, JSON.stringify(groups, null, 2), 'utf-8');
    return updated;
  },

  logPairingAttempt(entry: Omit<PairingAuditEntry, 'id' | 'timestamp'>): PairingAuditEntry {
    if (!pairingLogsCache) {
      pairingLogsCache = ensureJsonFile<PairingAuditEntry[]>(pairingLogsFile, []);
    }
    const created: PairingAuditEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    pairingLogsCache.unshift(created);
    if (pairingLogsCache.length > 150) pairingLogsCache.length = 150;
    scheduleDebouncedWrite(pairingLogsFile, () => pairingLogsCache || []);
    return created;
  },

  getPairingLogs(limit = 30): PairingAuditEntry[] {
    if (!pairingLogsCache) {
      pairingLogsCache = ensureJsonFile<PairingAuditEntry[]>(pairingLogsFile, []);
    }
    return pairingLogsCache.slice(0, limit);
  },
};
