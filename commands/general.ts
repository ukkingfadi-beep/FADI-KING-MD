import os from 'os';
import { loadConfig } from '../config/bot.config.ts';
import { vipStore } from '../utils/vipStore.ts';
import type { BotCommand, CommandCategory } from './types.ts';
import { getAllCommands } from './index.ts';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

const categoryLabels: Record<CommandCategory, string> = {
  general: '📌 GENERAL & BOT INFO',
  vip: '💎 VIP & PAIRING ACCESS',
  group: '🛡️ GROUP GUARD & STATUS',
  media: '🎧 MEDIA & SMART TOOLS',
  owner: '👑 OWNER & OPEN-GC LOCK',
};

export const generalCommands: BotCommand[] = [
  {
    name: 'menu',
    aliases: ['help', 'commands'],
    category: 'general',
    description: 'Saaf suthra aur complete command menu show kare',
    usage: 'menu [category]',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const cmds = getAllCommands();
      const filterCat = ctx.args[0]?.toLowerCase() as CommandCategory | undefined;

      const categories: CommandCategory[] = ['general', 'vip', 'group', 'media', 'owner'];
      const targetCategories =
        filterCat && categories.includes(filterCat) ? [filterCat] : categories;

      const roleLabel = ctx.isOwner ? 'OWNER' : ctx.isVip ? 'VIP' : 'MEMBER';
      const lines: string[] = [
        `╔══════════════════════════╗`,
        `   *${cfg.botName}*  (${cmds.length} Commands)`,
        `╚══════════════════════════╝`,
        `• *Prefix:* \`${cfg.prefix}\`   • *Mode:* *${cfg.mode === 'self' ? 'PRIVATE' : 'PUBLIC'}*`,
        `• *Role:* *${roleLabel}*   • *Anti-Scam:* *${cfg.antiScamGlobal ? 'ON' : 'OFF'}*`,
        `• *AI:* *${cfg.aiEnabled ? 'ON' : 'OFF'}*   • *Auto-React:* *${cfg.autoReact ? 'ON' : 'OFF'}*   • *SingleTick:* *${cfg.singleTick ? 'ON' : 'OFF'}*`,
        '',
      ];

      for (const cat of targetCategories) {
        const list = cmds.filter((c) => c.category === cat);
        lines.push(`┌─ *${categoryLabels[cat]}* (${list.length})`);
        for (const cmd of list) {
          lines.push(`│ ▸ \`${cfg.prefix}${cmd.name}\` — ${cmd.description}`);
        }
        lines.push(`└──────────────────────────`);
        lines.push('');
      }

      lines.push(`Tip: Filter with \`${cfg.prefix}menu group\`, \`${cfg.prefix}menu owner\`, or \`${cfg.prefix}menu media\`.`);
      const output = lines.join('\n').trim();
      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'ping',
    aliases: ['speed'],
    category: 'general',
    description: 'Bot response speed / latency check kare',
    usage: 'ping',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const start = performance.now();
      const msgTs = ctx.msg?.messageTimestamp
        ? Number(ctx.msg.messageTimestamp) * 1000
        : Date.now();
      const inboundDelta = Math.max(1, Math.round(Date.now() - msgTs));
      const execMs = Math.max(0.2, performance.now() - start).toFixed(2);
      const output = `*${loadConfig().botName} Pong*\n• Handler Latency: ${execMs} ms\n• Inbound Delta: ${ctx.isSimulated ? '12 ms (Console)' : `${inboundDelta} ms`}`;
      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'alive',
    aliases: ['runtime', 'status'],
    category: 'general',
    description: 'Bot uptime, memory usage aur active status bataye',
    usage: 'alive',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const uptime = formatUptime(process.uptime());
      const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const vipCount = vipStore.listVips().filter((v) => v.active).length;
      const output = [
        `*${cfg.botName} is Online*`,
        `• Uptime: ${uptime}`,
        `• Mode: ${cfg.mode.toUpperCase()} | Prefix: \`${cfg.prefix}\``,
        `• Memory: ${memMb} MB RSS (${os.platform()} ${os.arch()})`,
        `• Active VIPs: ${vipCount}`,
        `• Owner: ${cfg.ownerName} (+${cfg.ownerNumber})`,
      ].join('\n');
      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'owner',
    aliases: ['creator', 'dev'],
    category: 'general',
    description: 'Owner contact aur bot information show kare',
    usage: 'owner',
    cooldownSeconds: 5,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const output = [
        `*${cfg.botName} — Owner Info*`,
        `• Name: ${cfg.ownerName}`,
        `• WhatsApp: https://wa.me/${cfg.ownerNumber}`,
        `• VIP Pairing Gate: ${cfg.vipOnlyPairing ? 'Enabled (Authorized Only)' : 'Open'}`,
      ].join('\n');

      if (ctx.sock && !ctx.isSimulated) {
        const vcard = [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `FN:${cfg.ownerName}`,
          `TEL;type=CELL;type=VOICE;waid=${cfg.ownerNumber}:+${cfg.ownerNumber}`,
          'END:VCARD',
        ].join('\n');
        await ctx.sock.sendMessage(ctx.chatId, {
          contacts: {
            displayName: cfg.ownerName,
            contacts: [{ vcard }],
          },
        });
      }
      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'jid',
    aliases: ['chatid', 'id'],
    category: 'general',
    description: 'Current chat, sender, ya replied user ka JID show kare',
    usage: 'jid',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const lines = [
        `*${loadConfig().botName} — JID Info*`,
        `• Chat JID: \`${ctx.chatId}\``,
        `• Your JID: \`${ctx.senderJid}\``,
        `• Phone: +${ctx.senderNumber}`,
      ];
      const msg = lines.join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
];
