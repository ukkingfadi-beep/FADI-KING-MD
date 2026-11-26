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

export interface PortalBannerState {
  enabled: boolean;
  mediaType: LiveMediaType;
  mediaUrl: string;
  caption: string;
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
    vipOnlyPairing: boolean;
    prefix: string;
    botName: string;
    activePaidUsersCount: number;
  };
  portalBanner: PortalBannerState;
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
  antiVirusGlobal?: boolean;
  autoForwardIbToOpenGcs: boolean;
  autoReact: boolean;
  aiEnabled: boolean;
  alwaysOnline?: boolean;
  singleTick: boolean;
  stickerPack: string;
  stickerAuthor: string;
  menuImageUrl: string;
  menuChannelJid: string;
  menuChannelName: string;
  menuChannelUrl: string;
  welcomeMessage?: string;
  goodbyeMessage?: string;
}

export interface BlockedCallerEntry {
  jid: string;
  phone: string;
  label?: string;
  addedAt: string;
}

export interface VirusBlacklistEntry {
  jid: string;
  number: string;
  categories: string[];
  reason: string;
  chatId: string;
  blockedAt: string;
  hits: number;
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
  database?: {
    engine: 'mongodb+sqlite' | 'postgres+sqlite' | 'sqlite';
    dataDir: string;
    sessionDir: string;
    persistentVolumeMounted: boolean;
    mongoConfigured: boolean;
    postgresConfigured: boolean;
  };
  stats: {
    serverOnline: boolean;
    botOnline: boolean;
    activeVips: number;
    activePaidUsersCount: number;
    paidUsers: Array<{
      number: string;
      name: string;
      tier: VipTier | 'paired';
      online?: boolean;
      pairingCount: number;
      lastPairedAt?: string;
    }>;
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
  cooldownSeconds?: number;
  delaySeconds?: number;
  deleteAfterSeconds?: number;
}

export type AntilinkMode = 'off' | 'delete' | 'warn' | 'kick';

export interface GroupConfig {
  groupId: string;
  antilink: boolean;
  antilinkMode?: AntilinkMode;
  antiScam?: boolean;
  antiStatusMention?: boolean;
  antiVirus?: boolean;
  antiAdd?: boolean;
  antiForward?: boolean;
  antiMedia?: boolean;
  antiSticker?: boolean;
  antiBot?: boolean;
  antiPayMsg?: boolean;
  antiAdmin?: boolean;
  antiAdminKick?: boolean;
  antiKickAll?: boolean;
  gcStatusRemove?: boolean;
  slowModeSeconds?: number;
  aiEnabled?: boolean;
  welcome: boolean;
  welcomeMessage?: string;
  goodbye: boolean;
  goodbyeMessage?: string;
}

export interface SourceFileEntry {
  path: string;
  content: string;
}

export type ReportActionType = 'ban' | 'unban';

export interface ReportTemplate {
  id: string;
  type: ReportActionType;
  title: string;
  body: string;
  enabled: boolean;
  createdAt: string;
}

export interface ReportSettingsView {
  banRepeatCount: number;
  unbanRepeatCount: number;
  blockOnBan: boolean;
  unblockOnUnban: boolean;
  sendSpamStanzaOnBan: boolean;
  echoReportsInChat: boolean;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  hasSmtpPass: boolean;
  supportRecipients: string;
}

export interface ReportExecutionLog {
  id: string;
  type: ReportActionType;
  targetNumber: string;
  targetJid: string;
  triggeredBy: string;
  templateCount: number;
  totalReportsFired: number;
  spamStanzasAccepted: number;
  spamStanzasAttempted: number;
  emailsSent: number;
  emailsAttempted: number;
  emailError?: string;
  blockActionStatus: string;
  appliedReports: Array<{ title: string; body: string }>;
  summary: string;
  timestamp: string;
}

export type LiveSessionState =
  | 'active'
  | 'connecting'
  | 'offline'
  | 'logged_out'
  | 'not_paired';

export interface LiveControlUserEntry {
  number: string;
  name: string;
  tier: VipTier | 'paired';
  sessionId: string | null;
  liveStatus: LiveSessionState;
  online: boolean;
  pairingCount: number;
  lastPairedAt?: string;
  chatCount: number;
  messageCount: number;
  lastActivityAt: number;
  canReconnect: boolean;
  canDisconnect: boolean;
}

export interface LiveControlOverview {
  counts: {
    totalUsers: number;
    pairedCount: number;
    notPairedCount: number;
    activeCount: number;
    inactiveCount: number;
    loggedOutCount: number;
    mainConnected: boolean;
    activeSubSessions: number;
  };
  users: LiveControlUserEntry[];
}

export interface LiveChatThreadItem {
  chatId: string;
  chatType: 'dm' | 'group';
  name: string;
  phone: string;
  lastMessage: string;
  lastSenderName: string;
  lastFromMe: boolean;
  lastTimestamp: number;
  messageCount: number;
  participantCount?: number;
  adminCount?: number;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  announce?: boolean;
  restrict?: boolean;
}

export interface LiveChatMessageItem {
  id: string;
  chatId: string;
  senderJid: string;
  senderNumber: string;
  senderName: string;
  fromMe: boolean;
  text: string;
  mediaType:
    | 'text'
    | 'image'
    | 'video'
    | 'audio'
    | 'sticker'
    | 'document'
    | 'location'
    | 'contact'
    | 'poll'
    | 'payment'
    | 'other';
  mimetype?: string;
  fileName?: string;
  hasMedia?: boolean;
  ptt?: boolean;
  seconds?: number;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
  timestamp: number;
  key?: {
    remoteJid: string;
    id: string;
    fromMe: boolean;
    participant?: string;
  };
}

export interface LiveStatusItem {
  id: string;
  mediaType: 'image' | 'video' | 'audio' | 'text';
  caption?: string;
  textBody?: string;
  backgroundArgb?: number;
  mimetype?: string;
  ptt?: boolean;
  seconds?: number;
  senderPhone: string;
  senderJid: string;
  pushName: string;
  timestampMs: number;
  hasBuffer: boolean;
  sessionKeys: string[];
}

export interface LiveGroupParticipantItem {
  jid: string;
  lid?: string;
  phone: string;
  name: string;
  role: 'superadmin' | 'admin' | 'member';
  isSelf: boolean;
}

export interface LiveGroupDetailItem {
  id: string;
  subject: string;
  desc: string;
  owner: string;
  creation?: number;
  announce: boolean;
  restrict: boolean;
  isBotAdmin: boolean;
  isBotSuperAdmin: boolean;
  participantCount: number;
  adminCount: number;
  botConfig: GroupConfig;
  participants: LiveGroupParticipantItem[];
}

