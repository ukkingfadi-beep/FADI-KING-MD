import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

export type CommandCategory = 'general' | 'vip' | 'group' | 'media' | 'owner';

export interface CommandContext {
  sock: WASocket | null;
  msg: WAMessage | null;
  chatId: string;
  senderJid: string;
  senderCandidates?: string[];
  senderNumber: string;
  pushName: string;
  isGroup: boolean;
  isOwner: boolean;
  isVip: boolean;
  prefix: string;
  commandName: string;
  args: string[];
  text: string;
  isSimulated: boolean;
  reply: (text: string) => Promise<void>;
  sendText: (jid: string, text: string) => Promise<void>;
  getCachedMessage?: (chatId: string, msgId: string) => WAMessage | undefined;
}

export interface BotCommand {
  name: string;
  aliases?: string[];
  category: CommandCategory;
  description: string;
  usage: string;
  ownerOnly?: boolean;
  vipOnly?: boolean;
  groupOnly?: boolean;
  cooldownSeconds?: number;
  execute: (ctx: CommandContext) => Promise<string | void>;
}
