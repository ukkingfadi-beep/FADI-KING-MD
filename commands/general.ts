import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, saveConfig } from '../config/bot.config.ts';
import { getBotSnapshot } from '../handlers/connection.ts';
import { liveStore } from '../utils/liveStore.ts';
import { addReminder, formatDurationHuman, parseDurationMs } from '../utils/reminderStore.ts';
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

interface MenuSectionSpec {
  id: string;
  categories: CommandCategory[];
  banner: string;
  commands: string[];
}

const MENU_SECTIONS: MenuSectionSpec[] = [
  {
    id: 'core',
    categories: ['general'],
    banner: '┌──「 ✨ CORE ✨ 」',
    commands: [
      'menu',
      'ping',
      'alive',
      'owner',
      'jid',
      'botlink',
      'botinfo',
      'reminder',
      'afkon',
      'afkoff',
    ],
  },
  {
    id: 'vip',
    categories: ['vip'],
    banner: '┌──「 💎 VIP ACCESS 💎 」',
    commands: ['pair', 'addvip', 'delvip', 'viplist', 'checkvip'],
  },
  {
    id: 'security',
    categories: ['group'],
    banner: '┌──「 🛡️ GROUP SECURITY 🛡️ 」',
    commands: [
      'antiadmin',
      'antiadminkick',
      'antikickall',
      'antilink',
      'gcstatusremove',
      'antiadd',
      'antiforward',
      'antimedia',
      'antisticker',
      'antibot',
      'antipaymsg',
      'antidelete',
      'antiscam',
      'antimention',
      'bansticker',
    ],
  },
  {
    id: 'group',
    categories: ['group'],
    banner: '┌──「 👥 GROUP & ADMIN 👥 」',
    commands: [
      'kick',
      'add',
      'kickall',
      'welcomeimg',
      'welcome',
      'setwelcome',
      'goodbye',
      'setgoodbye',
      'group',
      'mute',
      'unmute',
      'link',
      'revoke',
      'setname',
      'setdesc',
      'promote',
      'demote',
      'warn',
      'clearwarn',
      'slowmode',
      'tagadmin',
      'tagall',
      'hidetag',
      'groupinfo',
      'setpp',
      'groupdp',
      'poll',
      'approve',
      'rejectall',
      'pin',
      'unpin',
      'muteuser',
      'unmuteuser',
      'giveaway',
      'multimessage',
      'gclist',
      'gcstatus',
      'resetgroup',
      'left',
    ],
  },
  {
    id: 'media',
    categories: ['media'],
    banner: '┌──「 🎨 MEDIA & VOICE 🎨 」',
    commands: [
      's',
      'toimg',
      'vv',
      'info',
      'del',
      'tts',
      'save',
      'savestatus',
      'qr',
      'calc',
      'say',
      'quote',
      'tr',
      'weather',
      'wa',
      'savedp',
      'contactsave',
      'bassboost',
      'stickerinfo',
    ],
  },
  {
    id: 'ai_tools',
    categories: ['media', 'owner'],
    banner: '┌──「 🤖 AI & SMART TOOLS 🤖 」',
    commands: [
      'ai',
      'roast',
      'factcheck',
      'summarize',
      'grammar',
      'checklink',
      'poetry',
      'bio',
      'cricket',
    ],
  },
  {
    id: 'downloaders',
    categories: ['media'],
    banner: '┌──「 📥 DOWNLOADERS 📥 」',
    commands: ['yt', 'fb', 'twitter', 'pinterest', 'tiktok', 'ig'],
  },
  {
    id: 'owner',
    categories: ['owner'],
    banner: '┌──「 👑 OWNER 👑 」',
    commands: [
      'mode',
      'setprefix',
      'block',
      'unblock',
      'ban',
      'unban',
      'anticall',
      'broadcast',
      'autoread',
      'autostatus',
      'autotyping',
      'autorecord',
      'opengc',
      'ibpost',
      'autoreact',
      'singletick',
      'restart',
      'alwaysonline',
      'clearchat',
      'blocklist',
    ],
  },
];

const commandEmojiMap: Record<string, string> = {
  menu: '📜',
  ping: '⚡',
  alive: '💠',
  owner: '👑',
  jid: '🆔',
  botlink: '🌐',
  botinfo: '📊',
  reminder: '⏰',
  afkon: '🌙',
  afkoff: '☀️',
  pair: '🔗',
  addvip: '➕',
  delvip: '➖',
  viplist: '📋',
  checkvip: '✅',
  antiadmin: '🛡️',
  antiadminkick: '🛡️',
  antikickall: '🛑',
  antilink: '🚫',
  gcstatusremove: '🚫',
  antiadd: '🚷',
  antiforward: '⏭️',
  antimedia: '📵',
  antisticker: '🎭',
  antibot: '🤖',
  antipaymsg: '💳',
  antipay: '💳',
  antipaylock: '💳',
  nopaymsg: '💳',
  antidelete: '👁️',
  antiscam: '🔰',
  antimention: '🔕',
  bansticker: '🚯',
  kick: '🥾',
  add: '📲',
  kickall: '💥',
  welcomeimg: '🖼️',
  welcome: '🎉',
  setwelcome: '✍️',
  goodbye: '🚪',
  setgoodbye: '✍️',
  group: '👥',
  mute: '🔇',
  unmute: '🔊',
  link: '🔗',
  revoke: '♻️',
  setname: '✏️',
  setdesc: '📝',
  promote: '⬆️',
  demote: '⬇️',
  warn: '⚠️',
  clearwarn: '🧽',
  slowmode: '🐢',
  tagadmin: '🔔',
  tagall: '📢',
  hidetag: '👻',
  groupinfo: 'ℹ️',
  setpp: '🖼️',
  groupdp: '📸',
  poll: '📊',
  approve: '✅',
  rejectall: '❌',
  pin: '📌',
  unpin: '📍',
  muteuser: '🤐',
  unmuteuser: '🗣️',
  giveaway: '🎁',
  multimessage: '⚡',
  gclist: '📂',
  gcstatus: '📣',
  resetgroup: '🔄',
  left: '👋',
  s: '🎨',
  toimg: '🖼️',
  vv: '👁️',
  info: 'ℹ️',
  del: '🗑️',
  tts: '🗣️',
  save: '💾',
  savestatus: '📥',
  qr: '📷',
  calc: '🧮',
  say: '💬',
  quote: '💭',
  tr: '🌐',
  weather: '🌦️',
  wa: '📱',
  savedp: '🖼️',
  contactsave: '📇',
  bassboost: '🔊',
  stickerinfo: '🏷️',
  paymsg: '☑️',
  paylock: '☑️',
  reqpay: '☑️',
  encmsg: '☑️',
  admindelblock: '☑️',
  ai: '🤖',
  roast: '🔥',
  factcheck: '🧐',
  summarize: '📝',
  grammar: '✍️',
  checklink: '🔎',
  poetry: '🖋️',
  bio: '✨',
  cricket: '🏏',
  yt: '▶️',
  fb: '📘',
  twitter: '🐦',
  pinterest: '📌',
  tiktok: '🎵',
  ig: '📸',
  mode: '⚙️',
  setprefix: '🎛️',
  block: '🚫',
  unblock: '✅',
  ban: '🔨',
  unban: '🔓',
  anticall: '📵',
  broadcast: '📢',
  autoread: '👀',
  autostatus: '🟢',
  autotyping: '⌨️',
  autorecord: '🎙️',
  opengc: '📤',
  ibpost: '📨',
  autoreact: '💖',
  singletick: '☑️',
  restart: '🔄',
  alwaysonline: '🟢',
  clearchat: '🧹',
  blocklist: '📛',
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
  const cmdSet = new Set(cmds.map((c) => c.name.toLowerCase()));
  const assigned = new Set<string>();

  const uptime = formatUptime(process.uptime());
  const safeBotName = String(cfg.botName || 'FADI KING MD').trim() || 'FADI KING MD';
  const safeOwnerName = String(cfg.ownerName || 'FADI KING').trim() || 'FADI KING';
  const safePrefix = String(cfg.prefix || '.').trim() || '.';
  const safeMode = cfg.mode === 'self' ? 'PRIVATE' : 'PUBLIC';

  const lines: string[] = [
    `┌──「 👑 *${safeBotName.toUpperCase()}* 👑 」`,
    `│🤖 *BOT:* ${safeBotName.toUpperCase()}`,
    `│🔱 *OWNER:* ${safeOwnerName.toUpperCase()}`,
    `│📊 *COMMANDS:* ${cmds.length}`,
    `│⏱️ *RUNTIME:* ${uptime}`,
    `│📦 *PREFIX:* ${safePrefix}`,
    `│⚙️ *MODE:* ${safeMode}`,
    `└───────────────`,
    '',
  ];

  const targetSections = filterCat
    ? MENU_SECTIONS.filter((s) => s.categories.includes(filterCat))
    : MENU_SECTIONS;

  for (const section of targetSections) {
    const items = section.commands.filter((name) => {
      if (!cmdSet.has(name) || assigned.has(name)) return false;
      assigned.add(name);
      return true;
    });

    // Include any newly added commands belonging to this section's default category
    if (!filterCat || section.categories.includes(filterCat)) {
      const defaultCategoryBucket: Record<CommandCategory, string> = {
        general: 'core',
        vip: 'vip',
        group: 'group',
        media: 'media',
        owner: 'owner',
      };
      for (const cmd of cmds) {
        const lower = cmd.name.toLowerCase();
        if (assigned.has(lower)) continue;
        if (
          defaultCategoryBucket[cmd.category] === section.id &&
          !MENU_SECTIONS.some((other) => other.commands.includes(lower))
        ) {
          assigned.add(lower);
          items.push(lower);
        }
      }
    }

    if (items.length === 0) continue;

    lines.push(section.banner);
    for (const cmdName of items) {
      const icon = commandEmojiMap[cmdName] || '🔹';
      lines.push(`│${icon} ${safePrefix}${cmdName.toUpperCase()}`);
    }
    lines.push('└───────────────');
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
          try {
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
          } catch {
            if (contextInfo) {
              try {
                await ctx.sock.sendMessage(
                  ctx.chatId,
                  { image: imgBuf, caption: output },
                  { quoted: ctx.msg ?? undefined }
                );
                return output;
              } catch {
                // Fall back to text reply below
              }
            }
          }
        }

        if (contextInfo) {
          try {
            await ctx.sock.sendMessage(
              ctx.chatId,
              {
                text: output,
                contextInfo,
              },
              { quoted: ctx.msg ?? undefined }
            );
            return output;
          } catch {
            // Fall back to plain reply below
          }
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
      const output = `*${loadConfig().botName || 'FADI KING MD'} Pong*\n• Handler Latency: ${execMs} ms\n• Inbound Delta: ${ctx.isSimulated ? '12 ms (Console)' : `${inboundDelta} ms`}`;
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
      const safeBotName = String(cfg.botName || 'FADI KING MD');
      const safeMode = (cfg.mode || 'public').toUpperCase();
      const safePrefix = String(cfg.prefix || '.');
      const output = [
        `*${safeBotName} is Online*`,
        `• Uptime: ${uptime}`,
        `• Mode: ${safeMode} | Prefix: \`${safePrefix}\``,
        `• Memory: ${memMb} MB RSS (${os.platform()} ${os.arch()})`,
        `• Active VIPs: ${vipCount}`,
        `• Owner: ${cfg.ownerName || 'FADI KING'} (+${cfg.ownerNumber})`,
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
  {
    name: 'botlink',
    aliases: ['portal', 'website', 'linkbot', 'deploylink'],
    category: 'general',
    description: 'Bot ke official Web Pairing Portal aur home URL ka link bheje',
    usage: 'botlink',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const officialBotUrl = 'https://fadi-king-md-production-29665dad.up.railway.app';
      const railwayDomain =
        process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || process.env.RAILWAY_STATIC_URL?.trim();
      const portalUrl =
        process.env.PUBLIC_PORTAL_URL?.trim() ||
        (railwayDomain
          ? railwayDomain.startsWith('http')
            ? railwayDomain
            : `https://${railwayDomain}`
          : '') ||
        officialBotUrl;

      const channelLine = cfg.menuChannelUrl?.trim()
        ? `• Official Channel: ${cfg.menuChannelUrl.trim()}`
        : cfg.autoJoinChannelInvite?.trim()
          ? `• Official Channel: ${cfg.autoJoinChannelInvite.trim()}`
          : '';

      const output = [
        `🌐 *${cfg.botName || 'FADI KING MD'} — Official Portal*`,
        `• Web Pairing Portal: ${portalUrl}`,
        ...(channelLine ? [channelLine] : []),
        `• Prefix: \`${cfg.prefix}\` | Mode: ${(cfg.mode || 'public').toUpperCase()}`,
        `• Owner: ${cfg.ownerName || 'FADI KING'} (+${cfg.ownerNumber})`,
        '',
        `Open the portal link to generate an 8-digit pairing code or scan QR.`,
      ].join('\n');

      if (ctx.sock && !ctx.isSimulated) {
        const contextInfo = await resolveNewsletterContext(ctx.sock, cfg).catch(() => null);
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            text: output,
            ...(contextInfo ? { contextInfo } : {}),
          },
          { quoted: ctx.msg ?? undefined }
        );
        return output;
      }

      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'botinfo',
    aliases: ['stats', 'sysinfo', 'health'],
    category: 'general',
    description: 'Bot ki uptime, active groups/chats, RAM, CPU load aur version stats dikhaye',
    usage: 'botinfo',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const snap = getBotSnapshot();
      const mem = process.memoryUsage();
      const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
      const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const loadAvg = os.loadavg();
      const cpuCores = os.cpus()?.length || 1;
      const connectedSubs = snap.subSessions.filter((s) => s.status === 'connected').length;

      let activeGroupsCount: string = String(vipStore.listGroupConfigs().length);
      if (ctx.sock && !ctx.isSimulated) {
        try {
          const allGroups = await ctx.sock.groupFetchAllParticipating();
          activeGroupsCount = String(Object.keys(allGroups || {}).length);
        } catch {
          // Keep cached config count if group list fetch fails
        }
      }

      const output = [
        `📊 *${cfg.botName || 'FADI KING MD'} — System & Bot Health*`,
        `• Version: *v2.5 MD* | Prefix: \`${cfg.prefix}\``,
        `• Mode: *${cfg.mode === 'self' ? 'PRIVATE (Owner)' : 'PUBLIC'}*`,
        `• Uptime: *${formatUptime(process.uptime())}*`,
        `• Active Groups: *${activeGroupsCount}*`,
        `• Connected Sessions: *${(snap.status === 'connected' ? 1 : 0) + connectedSubs}*`,
        `• Total Commands: *${getAllCommands().length}*`,
        `• Memory Usage: *${rssMb} MB RSS* (${heapMb} MB Heap)`,
        `• CPU Load (1m/5m): *${loadAvg[0].toFixed(2)} / ${loadAvg[1].toFixed(2)}* (${cpuCores} cores)`,
        `• Platform: ${os.platform()} ${os.arch()} (Node ${process.version})`,
        `• Owner: ${cfg.ownerName || 'FADI KING'} (+${cfg.ownerNumber})`,
      ].join('\n');

      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'reminder',
    aliases: ['remind', 'remindme', 'alarm'],
    category: 'general',
    description: 'Persistent reminder set kare jo server restart ke baad bhi waqt par mention kare',
    usage: 'reminder <duration> <message> (e.g. .reminder 30m Check logs)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const durationToken = ctx.args[0]?.trim() || '';
      const messageText = ctx.args.slice(1).join(' ').trim();

      if (!durationToken || !messageText) {
        const msg = `Usage: \`${ctx.prefix}reminder <duration> <message>\`\nExamples:\n• \`${ctx.prefix}reminder 10m Check WhatsApp messages\`\n• \`${ctx.prefix}reminder 1h30m Restart backup\``;
        await ctx.reply(msg);
        return msg;
      }

      const delayMs = parseDurationMs(durationToken);
      if (!delayMs) {
        const msg = `Invalid duration \`${durationToken}\`. Use formats like \`30s\`, \`10m\`, \`2h\`, \`1d\`, or \`1h30m\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const reminder = addReminder({
        chatId: ctx.chatId,
        userJid: ctx.senderJid,
        userNumber: ctx.senderNumber,
        text: messageText,
        delayMs,
      });

      const msg = [
        `⏰ *Reminder Scheduled*`,
        `• In: *${formatDurationHuman(delayMs)}*`,
        `• Message: ${reminder.text}`,
        `• Will notify: +${reminder.userNumber}`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'afkon',
    aliases: ['afk'],
    category: 'general',
    description: 'Apna AFK (Away From Keyboard) status reason ke sath active kare',
    usage: 'afkon [reason]',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const reason = ctx.text.trim() || 'Busy right now — will reply later.';
      const entry = vipStore.setAfkUser({
        jid: ctx.senderJid,
        number: ctx.senderNumber,
        name: ctx.pushName,
        reason,
      });
      const msg = [
        `💤 *AFK Mode Enabled*`,
        `• User: +${entry.number}`,
        `• Reason: ${entry.reason}`,
        `_Anyone who mentions or replies to you will be notified automatically._`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'afkoff',
    aliases: ['back', 'unafk'],
    category: 'general',
    description: 'Apna AFK status band kare aur wapas active mode mein aaye',
    usage: 'afkoff',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const candidates = ctx.senderCandidates?.length
        ? ctx.senderCandidates
        : [ctx.senderJid, ctx.senderNumber];
      const cleared = candidates.map((c) => vipStore.clearAfkUser(c)).find(Boolean) || null;
      const msg = cleared
        ? `⚡ *Welcome back!* Your AFK status has been turned *OFF*.`
        : `Your AFK mode is not currently active.`;
      await ctx.reply(msg);
      return msg;
    },
  },
];
