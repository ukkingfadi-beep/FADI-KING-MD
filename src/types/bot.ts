export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'qr_ready'
  | 'pairing_ready'
  | 'connected'
  | 'logged_out'
  | 'disconnected';

export type VipTier = 'owner' | 'diamond' | 'gold';

export type CommandCategory = 'general' | 'vip' | 'group' | 'media' | 'owner';

export type LiveMediaType = 'none' | 'image' | 'video';

export type AlertLevel = 'info' | 'important' | 'urgent';

export interface LiveScreenState {
  active: boolean;
  title: string;
  message: string;
  mediaType: LiveMediaType;
  mediaUrl: string;
  updatedAt: string;
}

export interface AdminAlert {
  id: string;
  title: string;
  message: string;
  level: AlertLevel;
  createdAt: string;
}

export interface PublicStateResponse {
  bot: {
    status: ConnectionStatus;
    qrDataUrl: string | null;
    pairingCode: string | null;
    pairingPhone: string | null;
    connectedPhone: string | null;
    lastError: string | null;
    uptimeSeconds: number;
    vipOnlyPairing: boolean;
    pairCooldownSeconds: number;
    maxPairAttempts: number;
    pairWindowMinutes: number;
    prefix: string;
    botName: string;
    activeSessions?: Array<{ phone: string; status: ConnectionStatus }>;
  };
  liveScreen: LiveScreenState;
  alerts: AdminAlert[];
}

export interface BotConfigView {
  botName: string;
  ownerNumber: string;
  ownerName: string;
  prefix: string;
  mode: 'public' | 'self';
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
  stickerPack: string;
  stickerAuthor: string;
}

export interface BlockedCallerEntry {
  jid: string;
  phone: string;
  label?: string;
  addedAt: string;
}

export interface ActiveSessionInfo {
  sessionId: string;
  phone: string;
  status: ConnectionStatus;
  connectedUser?: { id: string; name: string; phone: string };
  lastPairingCode?: string;
  createdAt: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'security' | 'cmd';
  module: string;
  message: string;
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

export interface BotStatusResponse {
  bot: {
    status: ConnectionStatus;
    qrDataUrl: string | null;
    pairingCode: string | null;
    pairingPhone: string | null;
    connectedUser: { id: string; name: string; phone: string } | null;
    lastError: string | null;
    reconnectAttempts: number;
    hasSavedCreds: boolean;
    uptimeSeconds: number;
    subSessions: ActiveSessionInfo[];
    persistedSessions: string[];
  };
  config: BotConfigView;
  stats: {
    activeVips: number;
    totalPairings: number;
    commandCount: number;
    activeBlocks: number;
  };
  logs: LogEntry[];
  pairingLogs: PairingAuditEntry[];
  blockedKeys: Array<{ key: string; retryAfterSeconds: number; attempts: number }>;
}

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

export interface CommandItem {
  name: string;
  aliases: string[];
  category: CommandCategory;
  description: string;
  usage: string;
  ownerOnly: boolean;
  vipOnly: boolean;
  groupOnly: boolean;
}

export type AntilinkMode = 'off' | 'delete' | 'warn' | 'kick';

export interface GroupConfig {
  groupId: string;
  antilink: boolean;
  antilinkMode?: AntilinkMode;
  antiScam?: boolean;
  antiStatusMention?: boolean;
  welcome: boolean;
  goodbye: boolean;
}

export interface SourceFileEntry {
  path: string;
  content: string;
}
