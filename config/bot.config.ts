import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

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
  stickerPack: string;
  stickerAuthor: string;
  sessionDir: string;
  databaseDir: string;
}

const rootDir = process.cwd();
const databaseDir = path.resolve(rootDir, 'database');
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
  stickerPack: process.env.STICKER_PACK || 'FADI KING MD',
  stickerAuthor: process.env.STICKER_AUTHOR || 'VIP BOT',
  sessionDir: path.resolve(rootDir, process.env.SESSION_DIR || 'database/sessions'),
  databaseDir,
};

function ensureDirectories(): void {
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.mkdirSync(defaultConfig.sessionDir, { recursive: true });
}

let cachedConfig: BotConfig | null = null;

export function loadConfig(): BotConfig {
  if (cachedConfig && fs.existsSync(settingsFile)) return cachedConfig;
  ensureDirectories();
  try {
    if (fs.existsSync(settingsFile)) {
      const raw = fs.readFileSync(settingsFile, 'utf-8');
      const saved = JSON.parse(raw) as Partial<BotConfig>;
      cachedConfig = {
        ...defaultConfig,
        ...saved,
        ownerNumber: normalizePhone(saved.ownerNumber || defaultConfig.ownerNumber),
        sessionDir: defaultConfig.sessionDir,
        databaseDir: defaultConfig.databaseDir,
      };
      return cachedConfig;
    }
  } catch {
    // Fallback to defaults if settings file is corrupted
  }
  cachedConfig = { ...defaultConfig };
  saveConfig(cachedConfig);
  return cachedConfig;
}

export function saveConfig(partial: Partial<BotConfig>): BotConfig {
  ensureDirectories();
  const current = cachedConfig || { ...defaultConfig };
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
    sessionDir: defaultConfig.sessionDir,
    databaseDir: defaultConfig.databaseDir,
  };
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
    stickerPack: next.stickerPack,
    stickerAuthor: next.stickerAuthor,
  };
  fs.writeFileSync(settingsFile, JSON.stringify(persistable, null, 2), 'utf-8');
  return next;
}
