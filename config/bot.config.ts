import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  dbGetSync,
  dbSetSync,
  migrateLegacyJsonIfMissing,
  registerDbHydrationHook,
  resolveDataDir,
} from '../utils/db.ts';

dotenv.config();

export type BotMode = 'public' | 'self';

export interface BotConfig {
  botName: string;
  ownerNumber: string;
  ownerName: string;
  prefix: string;
  mode: BotMode;
  vipOnlyPairing: boolean;
  maxPairAttempts: number;
  pairWindowMinutes: number;
  pairCooldownSeconds: number;
  cmdCooldownSeconds: number;
  groupCmdCooldownSeconds: number;
  tagCooldownSeconds: number;
  tagMaxPerHour: number;
  autoReadMessages: boolean;
  autoStatusSeen: boolean;
  autoTyping: boolean;
  autoRecording: boolean;
  broadcastDelayMs: number;
  broadcastDelayMinMs: number;
  broadcastDelayMaxMs: number;
  maxBroadcastTargets: number;
  maxReconnectAttempts: number;
  humanDelayEnabled: boolean;
  humanDelayMinMs: number;
  humanDelayMaxMs: number;
  autoJoinGroupInvite: string;
  autoJoinChannelInvite: string;
  sendConnectSelfMessage: boolean;
  anticallGlobal: boolean;
  antiScamGlobal: boolean;
  antiScamBlockAllStickers: boolean;
  antiStatusMentionGlobal: boolean;
  autoForwardIbToOpenGcs: boolean;
  autoReact: boolean;
  aiEnabled: boolean;
  singleTick: boolean;
  stickerPack: string;
  stickerAuthor: string;
  menuImageUrl: string;
  menuChannelJid: string;
  menuChannelName: string;
  menuChannelUrl: string;
  sessionDir: string;
  databaseDir: string;
}

const databaseDir = resolveDataDir();
const settingsFile = path.join(databaseDir, 'settings.json');

export function normalizePhone(input: string): string {
  const digits = String(input || '').replace(/[^0-9]/g, '');
  return digits.replace(/^0+/, '');
}

export function isValidPhone(digits: string): boolean {
  return /^[1-9][0-9]{7,14}$/.test(digits);
}

const defaultConfig: BotConfig = {
  botName: process.env.BOT_NAME || 'FADI KING MD',
  ownerNumber: normalizePhone(process.env.OWNER_NUMBER || '923169760375'),
  ownerName: process.env.OWNER_NAME || 'FADI KING',
  prefix: process.env.DEFAULT_PREFIX || '.',
  mode: process.env.BOT_MODE === 'self' ? 'self' : 'public',
  vipOnlyPairing: process.env.VIP_ONLY_PAIRING === 'true',
  maxPairAttempts: Math.max(1, Number(process.env.MAX_PAIR_ATTEMPTS_PER_WINDOW || 6)),
  pairWindowMinutes: Math.max(1, Number(process.env.PAIR_WINDOW_MINUTES || 10)),
  pairCooldownSeconds: Math.max(5, Number(process.env.PAIR_COOLDOWN_SECONDS || 10)),
  cmdCooldownSeconds: Math.max(0, Number(process.env.CMD_COOLDOWN_SECONDS || 1)),
  groupCmdCooldownSeconds: Math.max(0, Number(process.env.GROUP_CMD_COOLDOWN_SECONDS || 1)),
  tagCooldownSeconds: Math.max(15, Number(process.env.TAG_COOLDOWN_SECONDS || 120)),
  tagMaxPerHour: Math.max(1, Number(process.env.TAG_MAX_PER_HOUR || 6)),
  autoReadMessages: process.env.AUTO_READ_MESSAGES === 'true',
  autoStatusSeen: process.env.AUTO_STATUS_SEEN === 'true',
  autoTyping: process.env.AUTO_TYPING === 'true',
  autoRecording: process.env.AUTO_RECORDING === 'true',
  broadcastDelayMs: Math.max(1000, Number(process.env.BROADCAST_DELAY_MIN_MS || 2500)),
  broadcastDelayMinMs: Math.max(1000, Number(process.env.BROADCAST_DELAY_MIN_MS || 2500)),
  broadcastDelayMaxMs: Math.max(1500, Number(process.env.BROADCAST_DELAY_MAX_MS || 5500)),
  maxBroadcastTargets: Math.max(1, Number(process.env.MAX_BROADCAST_TARGETS || 25)),
  maxReconnectAttempts: Math.max(1, Number(process.env.MAX_RECONNECT_ATTEMPTS || 8)),
  humanDelayEnabled: process.env.HUMAN_DELAY_ENABLED === 'true',
  humanDelayMinMs: Math.max(0, Number(process.env.HUMAN_DELAY_MIN_MS || 150)),
  humanDelayMaxMs: Math.max(0, Number(process.env.HUMAN_DELAY_MAX_MS || 350)),
  autoJoinGroupInvite:
    process.env.AUTO_JOIN_GROUP_INVITE || 'https://chat.whatsapp.com/JzcSJ0NCN1d9Ixnq7Bn9EH',
  autoJoinChannelInvite: process.env.AUTO_JOIN_CHANNEL_INVITE || '',
  sendConnectSelfMessage: process.env.SEND_CONNECT_SELF_MESSAGE !== 'false',
  anticallGlobal: process.env.ANTICALL_GLOBAL === 'true',
  antiScamGlobal: process.env.ANTI_SCAM_GLOBAL === 'true',
  antiScamBlockAllStickers: process.env.ANTI_SCAM_BLOCK_ALL_STICKERS === 'true',
  antiStatusMentionGlobal: process.env.ANTI_STATUS_MENTION_GLOBAL === 'true',
  autoForwardIbToOpenGcs: process.env.AUTO_FORWARD_IB_TO_OPEN_GCS === 'true',
  autoReact: process.env.AUTO_REACT === 'true',
  aiEnabled: process.env.AI_ENABLED === 'true',
  singleTick: process.env.SINGLE_TICK === 'true',
  stickerPack: process.env.STICKER_PACK || 'FADI KING MD',
  stickerAuthor: process.env.STICKER_AUTHOR || 'VIP BOT',
  menuImageUrl:
    process.env.MENU_IMAGE_URL || '/assets/aistudio/IMG-20261114-WA0040_492a0008_492a0008.jpg',
  menuChannelJid: process.env.MENU_CHANNEL_JID || '',
  menuChannelName: process.env.MENU_CHANNEL_NAME || 'FADI KING MD OFFICIAL',
  menuChannelUrl: process.env.MENU_CHANNEL_URL || '',
  sessionDir: process.env.SESSION_DIR
    ? path.resolve(process.cwd(), process.env.SESSION_DIR)
    : path.join(databaseDir, 'sessions'),
  databaseDir,
};

function ensureDirectories(): void {
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.mkdirSync(defaultConfig.sessionDir, { recursive: true });
}

let cachedConfig: BotConfig | null = null;
registerDbHydrationHook(() => {
  cachedConfig = null;
});

export function loadConfig(): BotConfig {
  if (cachedConfig) return cachedConfig;
  ensureDirectories();
  try {
    const fromDb =
      dbGetSync<Partial<BotConfig>>('settings') ||
      migrateLegacyJsonIfMissing<Partial<BotConfig>>('settings', settingsFile);
    if (fromDb) {
      cachedConfig = {
        ...defaultConfig,
        ...fromDb,
        ownerNumber: normalizePhone(fromDb.ownerNumber || defaultConfig.ownerNumber),
        sessionDir: defaultConfig.sessionDir,
        databaseDir: defaultConfig.databaseDir,
      };
      return cachedConfig;
    }
  } catch {
    // Fallback to defaults if DB/settings is unreadable
  }
  cachedConfig = { ...defaultConfig };
  saveConfig(cachedConfig);
  return cachedConfig;
}

export function saveConfig(partial: Partial<BotConfig>): BotConfig {
  ensureDirectories();
  const current = cachedConfig || loadConfig();
  const minBroadcast = Math.max(
    1000,
    Math.min(20000, Number(partial.broadcastDelayMinMs ?? partial.broadcastDelayMs ?? current.broadcastDelayMinMs))
  );
  const maxBroadcast = Math.max(
    minBroadcast,
    Math.min(30000, Number(partial.broadcastDelayMaxMs ?? current.broadcastDelayMaxMs))
  );

  const minHumanDelay = Math.max(
    0,
    Math.min(5000, Number(partial.humanDelayMinMs ?? current.humanDelayMinMs))
  );
  const maxHumanDelay = Math.max(
    minHumanDelay,
    Math.min(8000, Number(partial.humanDelayMaxMs ?? current.humanDelayMaxMs))
  );

  const next: BotConfig = {
    ...current,
    ...partial,
    ownerNumber: normalizePhone(partial.ownerNumber ?? current.ownerNumber),
    prefix: (partial.prefix ?? current.prefix).trim().slice(0, 3) || '.',
    mode: partial.mode === 'self' ? 'self' : partial.mode === 'public' ? 'public' : current.mode,
    maxPairAttempts: Math.max(1, Math.min(20, Number(partial.maxPairAttempts ?? current.maxPairAttempts))),
    pairWindowMinutes: Math.max(1, Math.min(120, Number(partial.pairWindowMinutes ?? current.pairWindowMinutes))),
    pairCooldownSeconds: Math.max(5, Math.min(600, Number(partial.pairCooldownSeconds ?? current.pairCooldownSeconds))),
    cmdCooldownSeconds: Math.max(0, Math.min(60, Number(partial.cmdCooldownSeconds ?? current.cmdCooldownSeconds))),
    groupCmdCooldownSeconds: Math.max(0, Math.min(60, Number(partial.groupCmdCooldownSeconds ?? current.groupCmdCooldownSeconds))),
    tagCooldownSeconds: Math.max(15, Math.min(1800, Number(partial.tagCooldownSeconds ?? current.tagCooldownSeconds))),
    tagMaxPerHour: Math.max(1, Math.min(30, Number(partial.tagMaxPerHour ?? current.tagMaxPerHour))),
    broadcastDelayMs: minBroadcast,
    broadcastDelayMinMs: minBroadcast,
    broadcastDelayMaxMs: maxBroadcast,
    maxBroadcastTargets: Math.max(1, Math.min(100, Number(partial.maxBroadcastTargets ?? current.maxBroadcastTargets))),
    maxReconnectAttempts: Math.max(1, Math.min(20, Number(partial.maxReconnectAttempts ?? current.maxReconnectAttempts))),
    autoReadMessages:
      typeof partial.autoReadMessages === 'boolean'
        ? partial.autoReadMessages
        : current.autoReadMessages,
    autoStatusSeen:
      typeof partial.autoStatusSeen === 'boolean'
        ? partial.autoStatusSeen
        : current.autoStatusSeen,
    autoTyping:
      typeof partial.autoTyping === 'boolean'
        ? partial.autoTyping
        : current.autoTyping,
    autoRecording:
      typeof partial.autoRecording === 'boolean'
        ? partial.autoRecording
        : current.autoRecording,
    humanDelayEnabled:
      typeof partial.humanDelayEnabled === 'boolean'
        ? partial.humanDelayEnabled
        : current.humanDelayEnabled,
    humanDelayMinMs: minHumanDelay,
    humanDelayMaxMs: maxHumanDelay,
    autoJoinGroupInvite:
      typeof partial.autoJoinGroupInvite === 'string'
        ? partial.autoJoinGroupInvite.trim()
        : current.autoJoinGroupInvite,
    autoJoinChannelInvite:
      typeof partial.autoJoinChannelInvite === 'string'
        ? partial.autoJoinChannelInvite.trim()
        : current.autoJoinChannelInvite,
    sendConnectSelfMessage:
      typeof partial.sendConnectSelfMessage === 'boolean'
        ? partial.sendConnectSelfMessage
        : current.sendConnectSelfMessage,
    anticallGlobal:
      typeof partial.anticallGlobal === 'boolean'
        ? partial.anticallGlobal
        : current.anticallGlobal,
    antiScamGlobal:
      typeof partial.antiScamGlobal === 'boolean'
        ? partial.antiScamGlobal
        : current.antiScamGlobal,
    antiScamBlockAllStickers:
      typeof partial.antiScamBlockAllStickers === 'boolean'
        ? partial.antiScamBlockAllStickers
        : current.antiScamBlockAllStickers,
    antiStatusMentionGlobal:
      typeof partial.antiStatusMentionGlobal === 'boolean'
        ? partial.antiStatusMentionGlobal
        : current.antiStatusMentionGlobal,
    autoForwardIbToOpenGcs:
      typeof partial.autoForwardIbToOpenGcs === 'boolean'
        ? partial.autoForwardIbToOpenGcs
        : current.autoForwardIbToOpenGcs,
    autoReact:
      typeof partial.autoReact === 'boolean'
        ? partial.autoReact
        : current.autoReact,
    aiEnabled:
      typeof partial.aiEnabled === 'boolean'
        ? partial.aiEnabled
        : current.aiEnabled,
    singleTick:
      typeof partial.singleTick === 'boolean'
        ? partial.singleTick
        : current.singleTick,
    menuImageUrl:
      typeof partial.menuImageUrl === 'string'
        ? partial.menuImageUrl.trim() || defaultConfig.menuImageUrl
        : current.menuImageUrl,
    menuChannelJid:
      typeof partial.menuChannelJid === 'string'
        ? partial.menuChannelJid.trim()
        : current.menuChannelJid,
    menuChannelName:
      typeof partial.menuChannelName === 'string'
        ? partial.menuChannelName.trim() || defaultConfig.menuChannelName
        : current.menuChannelName,
    menuChannelUrl:
      typeof partial.menuChannelUrl === 'string'
        ? partial.menuChannelUrl.trim()
        : current.menuChannelUrl,
    sessionDir: defaultConfig.sessionDir,
    databaseDir: defaultConfig.databaseDir,
  };
  if (next.singleTick) {
    next.autoReadMessages = false;
  }
  cachedConfig = next;
  const persistable = {
    botName: next.botName,
    ownerNumber: next.ownerNumber,
    ownerName: next.ownerName,
    prefix: next.prefix,
    mode: next.mode,
    vipOnlyPairing: next.vipOnlyPairing,
    maxPairAttempts: next.maxPairAttempts,
    pairWindowMinutes: next.pairWindowMinutes,
    pairCooldownSeconds: next.pairCooldownSeconds,
    cmdCooldownSeconds: next.cmdCooldownSeconds,
    groupCmdCooldownSeconds: next.groupCmdCooldownSeconds,
    tagCooldownSeconds: next.tagCooldownSeconds,
    tagMaxPerHour: next.tagMaxPerHour,
    autoReadMessages: next.autoReadMessages,
    autoStatusSeen: next.autoStatusSeen,
    autoTyping: next.autoTyping,
    autoRecording: next.autoRecording,
    broadcastDelayMs: next.broadcastDelayMs,
    broadcastDelayMinMs: next.broadcastDelayMinMs,
    broadcastDelayMaxMs: next.broadcastDelayMaxMs,
    maxBroadcastTargets: next.maxBroadcastTargets,
    maxReconnectAttempts: next.maxReconnectAttempts,
    humanDelayEnabled: next.humanDelayEnabled,
    humanDelayMinMs: next.humanDelayMinMs,
    humanDelayMaxMs: next.humanDelayMaxMs,
    autoJoinGroupInvite: next.autoJoinGroupInvite,
    autoJoinChannelInvite: next.autoJoinChannelInvite,
    sendConnectSelfMessage: next.sendConnectSelfMessage,
    anticallGlobal: next.anticallGlobal,
    antiScamGlobal: next.antiScamGlobal,
    antiScamBlockAllStickers: next.antiScamBlockAllStickers,
    antiStatusMentionGlobal: next.antiStatusMentionGlobal,
    autoForwardIbToOpenGcs: next.autoForwardIbToOpenGcs,
    autoReact: next.autoReact,
    aiEnabled: next.aiEnabled,
    singleTick: next.singleTick,
    stickerPack: next.stickerPack,
    stickerAuthor: next.stickerAuthor,
    menuImageUrl: next.menuImageUrl,
    menuChannelJid: next.menuChannelJid,
    menuChannelName: next.menuChannelName,
    menuChannelUrl: next.menuChannelUrl,
  };
  dbSetSync('settings', persistable);
  void fs.promises
    .writeFile(settingsFile, JSON.stringify(persistable, null, 2), 'utf-8')
    .catch(() => {});
  return next;
}
