import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  dbGetSync,
  dbSeedSync,
  dbSetSync,
  migrateLegacyJsonIfMissing,
  registerDbHydrationHook,
  resolveDataDir,
  resolveSessionDir,
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
  antiVirusGlobal: boolean;
  autoForwardIbToOpenGcs: boolean;
  autoReact: boolean;
  aiEnabled: boolean;
  alwaysOnline: boolean;
  singleTick: boolean;
  stickerPack: string;
  stickerAuthor: string;
  menuImageUrl: string;
  menuChannelJid: string;
  menuChannelName: string;
  menuChannelUrl: string;
  botPortalUrl: string;
  welcomeMessage: string;
  goodbyeMessage: string;
  sessionDir: string;
  databaseDir: string;
}

const databaseDir = resolveDataDir();
const sessionDir = resolveSessionDir();
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
  antiVirusGlobal: process.env.ANTI_VIRUS_GLOBAL !== 'false',
  autoForwardIbToOpenGcs: process.env.AUTO_FORWARD_IB_TO_OPEN_GCS === 'true',
  autoReact: process.env.AUTO_REACT === 'true',
  aiEnabled: process.env.AI_ENABLED === 'true',
  alwaysOnline: process.env.ALWAYS_ONLINE === 'true',
  singleTick: process.env.SINGLE_TICK === 'true',
  stickerPack: process.env.STICKER_PACK || 'FADI KING MD',
  stickerAuthor: process.env.STICKER_AUTHOR || 'VIP BOT',
  menuImageUrl:
    process.env.MENU_IMAGE_URL || '/assets/aistudio/IMG-20261114-WA0040_492a0008_492a0008.jpg',
  menuChannelJid: process.env.MENU_CHANNEL_JID || '',
  menuChannelName: process.env.MENU_CHANNEL_NAME || 'FADI KING MD OFFICIAL',
  menuChannelUrl: process.env.MENU_CHANNEL_URL || '',
  botPortalUrl:
    process.env.PUBLIC_PORTAL_URL?.trim() ||
    'https://fadi-king-md-production-29665dad.up.railway.app',
  welcomeMessage: process.env.DEFAULT_WELCOME_MESSAGE || '',
  goodbyeMessage: process.env.DEFAULT_GOODBYE_MESSAGE || '',
  sessionDir,
  databaseDir,
};

function ensureDirectories(): void {
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
}

let cachedConfig: BotConfig | null = null;
registerDbHydrationHook(() => {
  cachedConfig = null;
});

function toPersistableConfig(cfg: BotConfig): Omit<BotConfig, 'sessionDir' | 'databaseDir'> {
  return {
    botName: cfg.botName,
    ownerNumber: cfg.ownerNumber,
    ownerName: cfg.ownerName,
    prefix: cfg.prefix,
    mode: cfg.mode,
    vipOnlyPairing: cfg.vipOnlyPairing,
    maxPairAttempts: cfg.maxPairAttempts,
    pairWindowMinutes: cfg.pairWindowMinutes,
    pairCooldownSeconds: cfg.pairCooldownSeconds,
    cmdCooldownSeconds: cfg.cmdCooldownSeconds,
    groupCmdCooldownSeconds: cfg.groupCmdCooldownSeconds,
    tagCooldownSeconds: cfg.tagCooldownSeconds,
    tagMaxPerHour: cfg.tagMaxPerHour,
    autoReadMessages: cfg.autoReadMessages,
    autoStatusSeen: cfg.autoStatusSeen,
    autoTyping: cfg.autoTyping,
    autoRecording: cfg.autoRecording,
    broadcastDelayMs: cfg.broadcastDelayMs,
    broadcastDelayMinMs: cfg.broadcastDelayMinMs,
    broadcastDelayMaxMs: cfg.broadcastDelayMaxMs,
    maxBroadcastTargets: cfg.maxBroadcastTargets,
    maxReconnectAttempts: cfg.maxReconnectAttempts,
    humanDelayEnabled: cfg.humanDelayEnabled,
    humanDelayMinMs: cfg.humanDelayMinMs,
    humanDelayMaxMs: cfg.humanDelayMaxMs,
    autoJoinGroupInvite: cfg.autoJoinGroupInvite,
    autoJoinChannelInvite: cfg.autoJoinChannelInvite,
    sendConnectSelfMessage: cfg.sendConnectSelfMessage,
    anticallGlobal: cfg.anticallGlobal,
    antiScamGlobal: cfg.antiScamGlobal,
    antiScamBlockAllStickers: cfg.antiScamBlockAllStickers,
    antiStatusMentionGlobal: cfg.antiStatusMentionGlobal,
    antiVirusGlobal: cfg.antiVirusGlobal,
    autoForwardIbToOpenGcs: cfg.autoForwardIbToOpenGcs,
    autoReact: cfg.autoReact,
    aiEnabled: cfg.aiEnabled,
    alwaysOnline: cfg.alwaysOnline,
    singleTick: cfg.singleTick,
    stickerPack: cfg.stickerPack,
    stickerAuthor: cfg.stickerAuthor,
    menuImageUrl: cfg.menuImageUrl,
    menuChannelJid: cfg.menuChannelJid,
    menuChannelName: cfg.menuChannelName,
    menuChannelUrl: cfg.menuChannelUrl,
    botPortalUrl: cfg.botPortalUrl,
    welcomeMessage: cfg.welcomeMessage,
    goodbyeMessage: cfg.goodbyeMessage,
  };
}

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
        botName: String(fromDb.botName || '').trim() || defaultConfig.botName,
        ownerName: String(fromDb.ownerName || '').trim() || defaultConfig.ownerName,
        ownerNumber: normalizePhone(fromDb.ownerNumber || defaultConfig.ownerNumber),
        prefix: String(fromDb.prefix || '').trim().slice(0, 3) || defaultConfig.prefix,
        mode: fromDb.mode === 'self' ? 'self' : 'public',
        vipOnlyPairing:
          typeof fromDb.vipOnlyPairing === 'boolean'
            ? fromDb.vipOnlyPairing
            : defaultConfig.vipOnlyPairing,
        stickerPack: String(fromDb.stickerPack || '').trim() || defaultConfig.stickerPack,
        stickerAuthor: String(fromDb.stickerAuthor || '').trim() || defaultConfig.stickerAuthor,
        menuImageUrl: String(fromDb.menuImageUrl || '').trim() || defaultConfig.menuImageUrl,
        menuChannelJid: String(fromDb.menuChannelJid ?? '').trim(),
        menuChannelName:
          String(fromDb.menuChannelName || '').trim() || defaultConfig.menuChannelName,
        menuChannelUrl: String(fromDb.menuChannelUrl ?? '').trim(),
        botPortalUrl:
          String(fromDb.botPortalUrl || '').trim() &&
          String(fromDb.botPortalUrl || '').trim() !== 'https://github.com/fadiking/fadi-king-md'
            ? String(fromDb.botPortalUrl || '').trim()
            : defaultConfig.botPortalUrl,
        welcomeMessage: String(fromDb.welcomeMessage ?? '').trim(),
        goodbyeMessage: String(fromDb.goodbyeMessage ?? '').trim(),
        sessionDir: defaultConfig.sessionDir,
        databaseDir: defaultConfig.databaseDir,
      };
      return cachedConfig;
    }
  } catch {
    // Fallback to defaults if DB/settings is unreadable
  }
  cachedConfig = { ...defaultConfig };
  dbSeedSync('settings', toPersistableConfig(cachedConfig));
  return cachedConfig;
}

export function saveConfig(partial: Partial<BotConfig>): BotConfig {
  ensureDirectories();
  const current = cachedConfig || loadConfig();
  const cleanPartial: Partial<BotConfig> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      (cleanPartial as Record<string, unknown>)[key] = value;
    }
  }

  const minBroadcast = Math.max(
    1000,
    Math.min(
      20000,
      Number(cleanPartial.broadcastDelayMinMs ?? cleanPartial.broadcastDelayMs ?? current.broadcastDelayMinMs) ||
        defaultConfig.broadcastDelayMinMs
    )
  );
  const maxBroadcast = Math.max(
    minBroadcast,
    Math.min(
      30000,
      Number(cleanPartial.broadcastDelayMaxMs ?? current.broadcastDelayMaxMs) ||
        defaultConfig.broadcastDelayMaxMs
    )
  );

  const minHumanDelay = Math.max(
    0,
    Math.min(
      5000,
      Number(cleanPartial.humanDelayMinMs ?? current.humanDelayMinMs) || 0
    )
  );
  const maxHumanDelay = Math.max(
    minHumanDelay,
    Math.min(
      8000,
      Number(cleanPartial.humanDelayMaxMs ?? current.humanDelayMaxMs) ||
        defaultConfig.humanDelayMaxMs
    )
  );

  const next: BotConfig = {
    ...current,
    ...cleanPartial,
    botName:
      (typeof cleanPartial.botName === 'string' ? cleanPartial.botName.trim() : '') ||
      String(current.botName || '').trim() ||
      defaultConfig.botName,
    ownerName:
      (typeof cleanPartial.ownerName === 'string' ? cleanPartial.ownerName.trim() : '') ||
      String(current.ownerName || '').trim() ||
      defaultConfig.ownerName,
    ownerNumber: normalizePhone(cleanPartial.ownerNumber ?? current.ownerNumber ?? defaultConfig.ownerNumber),
    prefix:
      (typeof cleanPartial.prefix === 'string' ? cleanPartial.prefix : current.prefix || '.')
        .trim()
        .slice(0, 3) || '.',
    mode:
      cleanPartial.mode === 'self'
        ? 'self'
        : cleanPartial.mode === 'public'
          ? 'public'
          : current.mode === 'self'
            ? 'self'
            : 'public',
    vipOnlyPairing:
      typeof cleanPartial.vipOnlyPairing === 'boolean'
        ? cleanPartial.vipOnlyPairing
        : Boolean(current.vipOnlyPairing),
    maxPairAttempts: Math.max(
      1,
      Math.min(20, Number(cleanPartial.maxPairAttempts ?? current.maxPairAttempts) || defaultConfig.maxPairAttempts)
    ),
    pairWindowMinutes: Math.max(
      1,
      Math.min(120, Number(cleanPartial.pairWindowMinutes ?? current.pairWindowMinutes) || defaultConfig.pairWindowMinutes)
    ),
    pairCooldownSeconds: Math.max(
      5,
      Math.min(
        600,
        Number(cleanPartial.pairCooldownSeconds ?? current.pairCooldownSeconds) || defaultConfig.pairCooldownSeconds
      )
    ),
    cmdCooldownSeconds: Math.max(
      0,
      Math.min(60, Number(cleanPartial.cmdCooldownSeconds ?? current.cmdCooldownSeconds) || 0)
    ),
    groupCmdCooldownSeconds: Math.max(
      0,
      Math.min(60, Number(cleanPartial.groupCmdCooldownSeconds ?? current.groupCmdCooldownSeconds) || 0)
    ),
    tagCooldownSeconds: Math.max(
      15,
      Math.min(
        1800,
        Number(cleanPartial.tagCooldownSeconds ?? current.tagCooldownSeconds) || defaultConfig.tagCooldownSeconds
      )
    ),
    tagMaxPerHour: Math.max(
      1,
      Math.min(30, Number(cleanPartial.tagMaxPerHour ?? current.tagMaxPerHour) || defaultConfig.tagMaxPerHour)
    ),
    broadcastDelayMs: minBroadcast,
    broadcastDelayMinMs: minBroadcast,
    broadcastDelayMaxMs: maxBroadcast,
    maxBroadcastTargets: Math.max(
      1,
      Math.min(
        100,
        Number(cleanPartial.maxBroadcastTargets ?? current.maxBroadcastTargets) || defaultConfig.maxBroadcastTargets
      )
    ),
    maxReconnectAttempts: Math.max(
      1,
      Math.min(
        20,
        Number(cleanPartial.maxReconnectAttempts ?? current.maxReconnectAttempts) || defaultConfig.maxReconnectAttempts
      )
    ),
    autoReadMessages:
      typeof cleanPartial.autoReadMessages === 'boolean'
        ? cleanPartial.autoReadMessages
        : Boolean(current.autoReadMessages),
    autoStatusSeen:
      typeof cleanPartial.autoStatusSeen === 'boolean'
        ? cleanPartial.autoStatusSeen
        : Boolean(current.autoStatusSeen),
    autoTyping:
      typeof cleanPartial.autoTyping === 'boolean'
        ? cleanPartial.autoTyping
        : Boolean(current.autoTyping),
    autoRecording:
      typeof cleanPartial.autoRecording === 'boolean'
        ? cleanPartial.autoRecording
        : Boolean(current.autoRecording),
    humanDelayEnabled:
      typeof cleanPartial.humanDelayEnabled === 'boolean'
        ? cleanPartial.humanDelayEnabled
        : Boolean(current.humanDelayEnabled),
    humanDelayMinMs: minHumanDelay,
    humanDelayMaxMs: maxHumanDelay,
    autoJoinGroupInvite:
      typeof cleanPartial.autoJoinGroupInvite === 'string'
        ? cleanPartial.autoJoinGroupInvite.trim()
        : String(current.autoJoinGroupInvite ?? ''),
    autoJoinChannelInvite:
      typeof cleanPartial.autoJoinChannelInvite === 'string'
        ? cleanPartial.autoJoinChannelInvite.trim()
        : String(current.autoJoinChannelInvite ?? ''),
    sendConnectSelfMessage:
      typeof cleanPartial.sendConnectSelfMessage === 'boolean'
        ? cleanPartial.sendConnectSelfMessage
        : Boolean(current.sendConnectSelfMessage ?? true),
    anticallGlobal:
      typeof cleanPartial.anticallGlobal === 'boolean'
        ? cleanPartial.anticallGlobal
        : Boolean(current.anticallGlobal),
    antiScamGlobal:
      typeof cleanPartial.antiScamGlobal === 'boolean'
        ? cleanPartial.antiScamGlobal
        : Boolean(current.antiScamGlobal),
    antiScamBlockAllStickers:
      typeof cleanPartial.antiScamBlockAllStickers === 'boolean'
        ? cleanPartial.antiScamBlockAllStickers
        : Boolean(current.antiScamBlockAllStickers),
    antiStatusMentionGlobal:
      typeof cleanPartial.antiStatusMentionGlobal === 'boolean'
        ? cleanPartial.antiStatusMentionGlobal
        : Boolean(current.antiStatusMentionGlobal),
    antiVirusGlobal:
      typeof cleanPartial.antiVirusGlobal === 'boolean'
        ? cleanPartial.antiVirusGlobal
        : Boolean(current.antiVirusGlobal ?? true),
    autoForwardIbToOpenGcs:
      typeof cleanPartial.autoForwardIbToOpenGcs === 'boolean'
        ? cleanPartial.autoForwardIbToOpenGcs
        : Boolean(current.autoForwardIbToOpenGcs),
    autoReact:
      typeof cleanPartial.autoReact === 'boolean'
        ? cleanPartial.autoReact
        : Boolean(current.autoReact),
    aiEnabled:
      typeof cleanPartial.aiEnabled === 'boolean'
        ? cleanPartial.aiEnabled
        : Boolean(current.aiEnabled),
    alwaysOnline:
      typeof cleanPartial.alwaysOnline === 'boolean'
        ? cleanPartial.alwaysOnline
        : Boolean(current.alwaysOnline),
    singleTick:
      typeof cleanPartial.singleTick === 'boolean'
        ? cleanPartial.singleTick
        : Boolean(current.singleTick),
    stickerPack:
      (typeof cleanPartial.stickerPack === 'string' ? cleanPartial.stickerPack.trim() : '') ||
      String(current.stickerPack || '').trim() ||
      defaultConfig.stickerPack,
    stickerAuthor:
      (typeof cleanPartial.stickerAuthor === 'string' ? cleanPartial.stickerAuthor.trim() : '') ||
      String(current.stickerAuthor || '').trim() ||
      defaultConfig.stickerAuthor,
    menuImageUrl:
      typeof cleanPartial.menuImageUrl === 'string'
        ? cleanPartial.menuImageUrl.trim() || defaultConfig.menuImageUrl
        : String(current.menuImageUrl || '').trim() || defaultConfig.menuImageUrl,
    menuChannelJid:
      typeof cleanPartial.menuChannelJid === 'string'
        ? cleanPartial.menuChannelJid.trim()
        : String(current.menuChannelJid ?? ''),
    menuChannelName:
      typeof cleanPartial.menuChannelName === 'string'
        ? cleanPartial.menuChannelName.trim() || defaultConfig.menuChannelName
        : String(current.menuChannelName || '').trim() || defaultConfig.menuChannelName,
    menuChannelUrl:
      typeof cleanPartial.menuChannelUrl === 'string'
        ? cleanPartial.menuChannelUrl.trim()
        : String(current.menuChannelUrl ?? ''),
    botPortalUrl:
      typeof cleanPartial.botPortalUrl === 'string'
        ? cleanPartial.botPortalUrl.trim() || defaultConfig.botPortalUrl
        : String(current.botPortalUrl || '').trim() || defaultConfig.botPortalUrl,
    welcomeMessage:
      typeof cleanPartial.welcomeMessage === 'string'
        ? cleanPartial.welcomeMessage.trim()
        : String(current.welcomeMessage ?? ''),
    goodbyeMessage:
      typeof cleanPartial.goodbyeMessage === 'string'
        ? cleanPartial.goodbyeMessage.trim()
        : String(current.goodbyeMessage ?? ''),
    sessionDir: defaultConfig.sessionDir,
    databaseDir: defaultConfig.databaseDir,
  };
  if (next.singleTick) {
    next.autoReadMessages = false;
  }
  cachedConfig = next;
  const persistable = toPersistableConfig(next);
  dbSetSync('settings', persistable);
  return next;
}
