import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, saveConfig } from '../config/bot.config.ts';
import { liveStore } from '../utils/liveStore.ts';
import { vipStore } from '../utils/vipStore.ts';
import type { BotCommand, CommandCategory } from './types.ts';
import { getAllCommands } from './index.ts';

const DEFAULT_MENU_DP_REL = 'public/assets/aistudio/IMG-20261114-WA0040_492a0008_492a0008.jpg';

const newsletterMetaCache = new Map<
  string,
  { newsletterJid: string; newsletterName: string; fetchedAt: number }
>();

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

function toMathBold(text: string): string {
  return Array.from(text)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d400 + (code - 65));
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d41a + (code - 97));
      if (code >= 48 && code <= 57) return String.fromCodePoint(0x1d7ce + (code - 48));
      return ch;
    })
    .join('');
}

const categoryBannerTitles: Record<CommandCategory, { emoji: string; label: string }> = {
  general: { emoji: '⚡', label: 'CORE' },
  vip: { emoji: '💎', label: 'VIP ACCESS' },
  group: { emoji: '🛡️', label: 'GROUP' },
  media: { emoji: '🎧', label: 'MEDIA & VOICE' },
  owner: { emoji: '👑', label: 'OWNER' },
};

const commandEmojiMap: Record<string, string> = {
  menu: '📜',
  ping: '⚡',
  alive: '💠',
  owner: '👑',
  jid: '🆔',
  pair: '🔗',
  vip: '💎',
  addvip: '➕',
  delvip: '➖',
  listvip: '📋',
  antilink: '🚫',
  antiscam: '🛡️',
  antistatus: '🔕',
  welcome: '🎉',
  goodbye: '👋',
  kick: '🥾',
  add: '📲',
  promote: '⬆️',
  demote: '⬇️',
  tagall: '📢',
  hidetag: '👻',
  mute: '🔒',
  unmute: '🔓',
  poll: '📊',
  fakepoll: '🗳️',
  autoreact: '💖',
  fakereact: '✨',
  react: '😍',
  s: '🎨',
  sticker: '🎨',
  vv: '👁️',
  tts: '🗣️',
  voice: '🎙️',
  ai: '🤖',
  savedp: '🖼️',
  dpsave: '🖼️',
  getpp: '🖼️',
  singletick: '☑️',
  anticall: '📵',
  status: '🟢',
  broadcast: '📡',
  bc: '📡',
  ib: '📨',
  mode: '⚙️',
};

export async function resolveMenuImageBuffer(configuredUrl: string): Promise<Buffer | null> {
  const url = String(configuredUrl || '').trim();
  const root = process.cwd();

  if (url.startsWith('/api/public/media/')) {
    const safeName = path.basename(url.slice('/api/public/media/'.length).split('?')[0]);
    if (safeName) {
      const diskPath = path.join(liveStore.getMediaDir(), safeName);
      if (fs.existsSync(diskPath)) {
        try {
          return fs.readFileSync(diskPath);
        } catch {
          // Try persisted DB blob next
        }
      }
      const persisted = liveStore.readPersistedMedia(safeName);
      if (persisted?.buffer?.length) {
        return persisted.buffer;
      }
    }
  } else if (url.startsWith('/assets/') || url.startsWith('/public/assets/')) {
    const cleanRel = url.replace(/^\/+(?:public\/)?/, '');
    const assetPath = path.join(root, 'public', cleanRel);
    if (fs.existsSync(assetPath)) {
      try {
        return fs.readFileSync(assetPath);
      } catch {
        // Fall through to default asset
      }
    }
  } else if (/^https?:\/\//i.test(url)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const arr = await res.arrayBuffer();
        if (arr.byteLength > 0 && arr.byteLength <= 15 * 1024 * 1024) {
          return Buffer.from(arr);
        }
      }
    } catch {
      // Fall back to default DP asset
    }
  }

  const defaultPath = path.join(root, DEFAULT_MENU_DP_REL);
  if (fs.existsSync(defaultPath)) {
    try {
      return fs.readFileSync(defaultPath);
    } catch {
      return null;
    }
  }
  return null;
}

export async function resolveNewsletterContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock: any,
  cfg: ReturnType<typeof loadConfig>
): Promise<{
  isForwarded: boolean;
  forwardingScore: number;
  forwardedNewsletterMessageInfo: {
    newsletterJid: string;
    newsletterName: string;
    serverMessageId: number;
  };
} | null> {
  const configuredJid = String(cfg.menuChannelJid || '').trim();
  const configuredName = String(cfg.menuChannelName || cfg.botName || 'FADI KING MD OFFICIAL').trim();

  if (configuredJid && configuredJid.includes('@newsletter')) {
    return {
      isForwarded: true,
      forwardingScore: 999,
      forwardedNewsletterMessageInfo: {
        newsletterJid: configuredJid,
        newsletterName: configuredName,
        serverMessageId: 1,
      },
    };
  }

  const rawUrl = String(cfg.menuChannelUrl || cfg.autoJoinChannelInvite || '').trim();
  if (!rawUrl) return null;

  const firstEntry = rawUrl.split(/[\n,]+/).map((s) => s.trim()).find(Boolean) || '';
  if (!firstEntry) return null;

  if (firstEntry.includes('@newsletter')) {
    return {
      isForwarded: true,
      forwardingScore: 999,
      forwardedNewsletterMessageInfo: {
        newsletterJid: firstEntry,
        newsletterName: configuredName,
        serverMessageId: 1,
      },
    };
  }

  const inviteMatch = firstEntry.match(/whatsapp\.com\/channel\/(?:invite\/)?([A-Za-z0-9_-]+)/i);
  if (!inviteMatch) return null;
  const code = inviteMatch[1];

  const cached = newsletterMetaCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < 6 * 3600 * 1000) {
    return {
      isForwarded: true,
      forwardingScore: 999,
      forwardedNewsletterMessageInfo: {
        newsletterJid: cached.newsletterJid,
        newsletterName: configuredName || cached.newsletterName,
        serverMessageId: 1,
      },
    };
  }

  if (sock && typeof sock.newsletterMetadata === 'function') {
    try {
      const meta = await sock.newsletterMetadata('invite', code);
      const jid = String(meta?.id || meta?.jid || '').trim();
      const name = String(
        meta?.thread_metadata?.name?.text || meta?.name || meta?.subject || configuredName
      ).trim();
      if (jid && jid.includes('@newsletter')) {
        newsletterMetaCache.set(code, {
          newsletterJid: jid,
          newsletterName: name,
          fetchedAt: Date.now(),
        });
        if (!cfg.menuChannelJid) {
          saveConfig({ menuChannelJid: jid });
        }
        return {
          isForwarded: true,
          forwardingScore: 999,
          forwardedNewsletterMessageInfo: {
            newsletterJid: jid,
            newsletterName: cfg.menuChannelName?.trim() || name,
            serverMessageId: 1,
          },
        };
      }
    } catch {
      // Non-fatal if newsletter lookup fails offline or in mock
    }
  }

  return null;
}

export function buildStylishMenuCaption(
  cfg: ReturnType<typeof loadConfig>,
  filterCat?: CommandCategory
): string {
  const cmds = getAllCommands();
  const categories: CommandCategory[] = ['general', 'vip', 'group', 'media', 'owner'];
  const targetCategories =
    filterCat && categories.includes(filterCat) ? [filterCat] : categories;

  const uptime = formatUptime(process.uptime());

  const lines: string[] = [
    `╭──✦ 🤖 「 *${toMathBold('BOT INFO')}* 」 ✦`,
    `│ ◈ 👑 *${toMathBold(cfg.botName.toUpperCase())}*`,
    `│ ◈ 🔱 *${toMathBold('OWNER')}:* *${toMathBold(cfg.ownerName.toUpperCase())}*`,
    `│ ◈ 📜 *${toMathBold('COMMANDS')}:* *${cmds.length}*`,
    `│ ◈ ⏱️ *${toMathBold('RUNTIME')}:* *${uptime}*`,
    `│ ◈ 📦 *${toMathBold('PREFIX')}:* *${cfg.prefix}*`,
    `│ ◈ ⚙️ *${toMathBold('MODE')}:* *${cfg.mode === 'self' ? toMathBold('PRIVATE') : toMathBold('PUBLIC')}*`,
    `╰─────────────✦`,
    '',
  ];

  for (const cat of targetCategories) {
    const list = cmds.filter((c) => c.category === cat);
    const meta = categoryBannerTitles[cat];
    lines.push(`╭──✦ ${meta.emoji} 「 *${toMathBold(meta.label)}* 」 ✦`);
    for (const cmd of list) {
      const icon = commandEmojiMap[cmd.name.toLowerCase()] || '◈';
      const cmdLabel = toMathBold(cmd.name.toUpperCase());
      lines.push(`│ ${icon} *${cfg.prefix}${cmdLabel}*`);
    }
    lines.push(`╰─────────────✦`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

export const generalCommands: BotCommand[] = [
  {
    name: 'menu',
    aliases: ['help', 'commands'],
    category: 'general',
    description: 'DP aur Channel style ke sath complete bold command menu show kare',
    usage: 'menu [category]',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const rawCat = ctx.args[0]?.toLowerCase() as CommandCategory | undefined;
      const validCats: CommandCategory[] = ['general', 'vip', 'group', 'media', 'owner'];
      const filterCat = rawCat && validCats.includes(rawCat) ? rawCat : undefined;

      const output = buildStylishMenuCaption(cfg, filterCat);

      if (ctx.sock && !ctx.isSimulated) {
        const [imgBuf, contextInfo] = await Promise.all([
          resolveMenuImageBuffer(cfg.menuImageUrl),
          resolveNewsletterContext(ctx.sock, cfg),
        ]);

        if (imgBuf) {
          await ctx.sock.sendMessage(
            ctx.chatId,
            {
              image: imgBuf,
              caption: output,
              ...(contextInfo ? { contextInfo } : {}),
            },
            { quoted: ctx.msg ?? undefined }
          );
          return output;
        }

        if (contextInfo) {
          await ctx.sock.sendMessage(
            ctx.chatId,
            {
              text: output,
              contextInfo,
            },
            { quoted: ctx.msg ?? undefined }
          );
          return output;
        }
      }

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
