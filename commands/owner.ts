import { isValidPhone, loadConfig, normalizePhone, saveConfig } from '../config/bot.config.ts';
import {
  applyAlwaysOnlinePresenceAcrossSockets,
  applySingleTickPresenceAcrossSockets,
} from '../handlers/connection.ts';
import { dispatchOpenGcProtectedPost } from '../handlers/group.ts';
import { anticallStore } from '../utils/anticallStore.ts';
import { crashGuardStore } from '../utils/crashGuard.ts';
import { generateAiChatReply } from '../utils/geminiService.ts';
import {
  extractBodyText,
  extractContextInfo,
  extractRawTargetCandidates,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  isLidUser,
  isParticipantAdmin,
  jidUserPart,
  normalizeBareJid,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import { extractQuotedMessage } from '../utils/mediaHelper.ts';
import { getRandomDelayMs } from '../utils/rateLimiter.ts';
import { executeMultiReport, reportStore } from '../utils/reportStore.ts';
import { vipStore } from '../utils/vipStore.ts';
import type { BotCommand, CommandContext } from './types.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDmOrMentionTarget(ctx: CommandContext): Promise<{
  primaryJid: string;
  candidates: string[];
  displayPhone: string;
} | null> {
  const candidates = new Set<string>();
  const add = (raw?: string | null) => {
    const bare = normalizeBareJid(raw);
    if (bare) candidates.add(bare);
  };

  const explicit = extractRawTargetCandidates(ctx.msg, ctx.args);
  if (explicit.length > 0) {
    for (const c of explicit) add(c);
  } else if (!ctx.isGroup && ctx.chatId) {
    // Inside someone's DM/IB: target the DM peer directly (works whether owner sent it fromMe or not)
    add(ctx.msg?.key?.remoteJidAlt);
    add(ctx.chatId);
  }

  for (const c of Array.from(candidates)) {
    if (isLidUser(c) && ctx.sock?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await ctx.sock.signalRepository.lidMapping.getPNForLID(c);
        if (pn) add(pn);
      } catch {
        // Ignore missing LID mapping
      }
    }
  }

  const all = Array.from(candidates);
  if (all.length === 0) return null;

  const pnJid = all.find((j) => j.endsWith('@s.whatsapp.net'));
  const primaryJid = pnJid || all[0];
  const displayPhone = normalizePhone(jidUserPart(primaryJid));

  return { primaryJid, candidates: all, displayPhone };
}

async function resolveBanOrUnbanInput(ctx: CommandContext): Promise<{
  primaryJid: string;
  candidates: string[];
  displayPhone: string;
  reason: string;
  quotedMsgId?: string;
} | null> {
  const ctxInfo = extractContextInfo(ctx.msg?.message);
  const quotedMsgId = ctxInfo?.stanzaId || undefined;

  const explicitCandidates = extractRawTargetCandidates(ctx.msg, ctx.args);
  if (explicitCandidates.length > 0 || !ctx.isGroup) {
    const resolved = await resolveDmOrMentionTarget(ctx);
    if (resolved && (resolved.displayPhone || resolved.primaryJid)) {
      let reasonTokens = [...ctx.args];
      if (
        reasonTokens[0] &&
        (reasonTokens[0].startsWith('@') || /^\+?\d{7,15}$/.test(reasonTokens[0]))
      ) {
        reasonTokens = reasonTokens.slice(1);
      }
      return {
        ...resolved,
        reason: reasonTokens.join(' ').trim(),
        quotedMsgId,
      };
    }
  }

  // Fallback for spaced/formatted numbers like ".ban +92 300 123 4567 spam"
  const raw = ctx.text.trim();
  const spacedMatch = raw.match(/^(\+?[\d][\d\s\-()]{6,22}\d)(?:\s+([\s\S]+))?$/);
  if (spacedMatch) {
    const digits = normalizePhone(spacedMatch[1]);
    if (isValidPhone(digits)) {
      const jid = `${digits}@s.whatsapp.net`;
      return {
        primaryJid: jid,
        candidates: [jid, digits],
        displayPhone: digits,
        reason: (spacedMatch[2] || '').trim(),
        quotedMsgId,
      };
    }
  }

  return null;
}

export const ownerCommands: BotCommand[] = [
  {
    name: 'mode',
    aliases: ['private', 'self'],
    category: 'owner',
    description: 'Bot ko public ya sirf Owner Private mode mein set kare',
    usage: 'mode <public|private|self>',
    ownerOnly: true,
    execute: async (ctx) => {
      const raw = ctx.args[0]?.toLowerCase();
      const target =
        ctx.commandName === 'private' || ctx.commandName === 'self'
          ? 'self'
          : raw === 'private' || raw === 'self'
            ? 'self'
            : raw === 'public'
              ? 'public'
              : null;

      if (!target) {
        const cur = loadConfig().mode;
        const msg = `Current mode: *${cur === 'self' ? 'PRIVATE (Owner Only)' : 'PUBLIC'}*\nUsage: \`${ctx.prefix}mode public\` or \`${ctx.prefix}mode private\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ mode: target });
      const msg =
        target === 'self'
          ? 'Bot mode updated to *PRIVATE (Owner Only)* — non-owners are blocked from commands while Web Pairing remains open.'
          : 'Bot mode updated to *PUBLIC*.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'setprefix',
    aliases: ['prefix'],
    category: 'owner',
    description: 'Command prefix symbol dynamically change kare',
    usage: 'setprefix <symbol>',
    ownerOnly: true,
    execute: async (ctx) => {
      const nextPrefix = ctx.args[0]?.trim();
      if (!nextPrefix || nextPrefix.length > 3) {
        const msg = `Provide a short prefix symbol (1-3 chars). Current: \`${loadConfig().prefix}\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ prefix: nextPrefix });
      const msg = `Command prefix changed to \`${nextPrefix}\`. Example: \`${nextPrefix}menu\``;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'block',
    aliases: ['blk'],
    category: 'owner',
    description: 'Kisi bhi DM/IB ya user ko WhatsApp par block kare',
    usage: 'block (in DM, reply, @user, or number)',
    ownerOnly: true,
    execute: async (ctx) => {
      const target = await resolveDmOrMentionTarget(ctx);
      if (!target) {
        const msg = `Use \`${ctx.prefix}block\` inside a user's DM/IB, or pass a number/mention.`;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated Block] Blocked +${target.displayPhone || target.primaryJid}.`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        await ctx.sock.updateBlockStatus(target.primaryJid, 'block');
        logger.security('owner', `Blocked contact +${target.displayPhone || target.primaryJid}`);
        const msg = `Blocked *+${target.displayPhone || jidUserPart(target.primaryJid)}* on WhatsApp.`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Block failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'unblock',
    aliases: ['unblk'],
    category: 'owner',
    description: 'Blocked user ko WhatsApp par unblock kare',
    usage: 'unblock (in DM, reply, @user, or number)',
    ownerOnly: true,
    execute: async (ctx) => {
      const target = await resolveDmOrMentionTarget(ctx);
      if (!target) {
        const msg = `Use \`${ctx.prefix}unblock\` inside a user's DM/IB, or pass a number/mention.`;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated Unblock] Unblocked +${target.displayPhone || target.primaryJid}.`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        await ctx.sock.updateBlockStatus(target.primaryJid, 'unblock');
        logger.info('owner', `Unblocked contact +${target.displayPhone || target.primaryJid}`);
        const msg = `Unblocked *+${target.displayPhone || jidUserPart(target.primaryJid)}* on WhatsApp.`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Unblock failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'anticall',
    aliases: ['callblock'],
    category: 'owner',
    description: 'Per-DM ya global incoming WhatsApp calls block/allow kare',
    usage: 'anticall <on|off|global on|global off|list>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg0 = ctx.args[0]?.toLowerCase() || '';
      const arg1 = ctx.args[1]?.toLowerCase() || '';
      const cfg = loadConfig();

      if (arg0 === 'global') {
        if (arg1 === 'on' || arg1 === 'off') {
          const enabled = arg1 === 'on';
          saveConfig({ anticallGlobal: enabled });
          logger.security('anticall', `Global Anti-Call turned ${enabled ? 'ON' : 'OFF'}`);
          const msg = `Global Anti-Call turned *${enabled ? 'ON (All incoming calls rejected)' : 'OFF'}*.`;
          await ctx.reply(msg);
          return msg;
        }
        const msg = `Global Anti-Call is currently *${cfg.anticallGlobal ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}anticall global on\` or \`${ctx.prefix}anticall global off\``;
        await ctx.reply(msg);
        return msg;
      }

      if (arg0 === 'list') {
        const blocked = anticallStore.listBlocked();
        const lines = [
          `*Anti-Call Status*`,
          `• Global Anti-Call: *${cfg.anticallGlobal ? 'ON' : 'OFF'}*`,
          `• Per-Chat Blocked (${blocked.length}):`,
          ...(blocked.length === 0
            ? ['  _None_']
            : blocked.map((b, i) => `  ${i + 1}. +${b.phone || jidUserPart(b.jid)}`)),
        ];
        const msg = lines.join('\n');
        await ctx.reply(msg);
        return msg;
      }

      if (arg0 === 'on' || arg0 === 'off') {
        // Resolve target if in DM, or if phone/mention provided
        const targetArgs = ctx.args.slice(1);
        const target = await resolveDmOrMentionTarget({ ...ctx, args: targetArgs });
        if (!target) {
          // If typed in a group without target, apply global toggle shortcut cleanly
          if (ctx.isGroup) {
            const enabled = arg0 === 'on';
            saveConfig({ anticallGlobal: enabled });
            const msg = `Global Anti-Call turned *${enabled ? 'ON' : 'OFF'}*.\n_Tip: Run \`${ctx.prefix}anticall on\` inside a private DM/IB to block calls only for that contact._`;
            await ctx.reply(msg);
            return msg;
          }
          const msg = `Usage: \`${ctx.prefix}anticall on\` / \`off\` inside a DM, or \`${ctx.prefix}anticall global on\`.`;
          await ctx.reply(msg);
          return msg;
        }

        if (arg0 === 'on') {
          const entry = anticallStore.blockCaller(target.primaryJid, target.displayPhone);
          logger.security('anticall', `Per-DM Anti-Call enabled for +${entry.phone}`);
          const msg = `Anti-Call *ON* for *+${entry.phone || jidUserPart(entry.jid)}*. Their voice & video calls will be automatically rejected.`;
          await ctx.reply(msg);
          return msg;
        } else {
          anticallStore.unblockCaller(target.candidates);
          logger.info('anticall', `Per-DM Anti-Call disabled for +${target.displayPhone}`);
          const msg = `Anti-Call *OFF* for *+${target.displayPhone || jidUserPart(target.primaryJid)}*. Calls from this contact are now allowed.`;
          await ctx.reply(msg);
          return msg;
        }
      }

      // Inspect current status
      const dmTarget = !ctx.isGroup ? await resolveDmOrMentionTarget(ctx) : null;
      const dmStatus = dmTarget ? anticallStore.isBlocked(dmTarget.candidates) : false;
      const msg = [
        `*Anti-Call Guard*`,
        `• Global Mode: *${cfg.anticallGlobal ? 'ON' : 'OFF'}*`,
        ...(dmTarget
          ? [`• This Chat (+${dmTarget.displayPhone}): *${dmStatus ? 'BLOCKED' : 'ALLOWED'}*`]
          : []),
        '',
        `Usage:`,
        `• \`${ctx.prefix}anticall on\` / \`off\` — Block/allow calls in this IB/DM`,
        `• \`${ctx.prefix}anticall global on\` / \`off\` — Block/allow all incoming calls`,
        `• \`${ctx.prefix}anticall list\` — Show blocked callers`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'broadcast',
    aliases: ['bc'],
    category: 'owner',
    description: 'Active groups/chats mein safe delay ke sath broadcast message bheje',
    usage: 'broadcast <text>',
    ownerOnly: true,
    execute: async (ctx) => {
      const text = ctx.text.trim();
      const cfg = loadConfig();
      if (!text) {
        const msg = `Usage: \`${ctx.prefix}broadcast Important update from ${cfg.botName}\``;
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const sampleDelay = getRandomDelayMs(cfg.broadcastDelayMinMs, cfg.broadcastDelayMaxMs);
        const msg = `[Simulated Broadcast] Safe jitter ${cfg.broadcastDelayMinMs}-${cfg.broadcastDelayMaxMs}ms (sample ${sampleDelay}ms), cap ${cfg.maxBroadcastTargets} targets:\n"${text}"`;
        await ctx.reply(msg);
        return msg;
      }

      const groupsMap = await ctx.sock.groupFetchAllParticipating();
      const allJids = Object.keys(groupsMap);

      if (allJids.length === 0) {
        const msg = 'No active groups found for broadcast.';
        await ctx.reply(msg);
        return msg;
      }

      if (allJids.length > cfg.maxBroadcastTargets) {
        logger.warn(
          'safetyGuard',
          `Broadcast target count (${allJids.length}) exceeded maxBroadcastTargets (${cfg.maxBroadcastTargets}). Capped to prevent spam ban.`
        );
      } else if (allJids.length >= Math.ceil(cfg.maxBroadcastTargets * 0.8)) {
        logger.warn(
          'safetyGuard',
          `Broadcast approaching target cap (${allJids.length}/${cfg.maxBroadcastTargets} groups).`
        );
      }

      const targetJids = allJids.slice(0, cfg.maxBroadcastTargets);
      await ctx.reply(
        `Starting safe broadcast to ${targetJids.length} groups (${cfg.broadcastDelayMinMs}-${cfg.broadcastDelayMaxMs}ms random delay)...`
      );

      let sent = 0;
      for (let i = 0; i < targetJids.length; i += 1) {
        const jid = targetJids[i];
        try {
          await ctx.sock.sendMessage(jid, {
            text: `*${cfg.botName} Broadcast*\n\n${text}`,
          });
          sent += 1;
        } catch (err) {
          logger.warn('broadcast', `Failed sending to ${jid}: ${(err as Error).message}`);
        }
        if (i < targetJids.length - 1) {
          await sleep(getRandomDelayMs(cfg.broadcastDelayMinMs, cfg.broadcastDelayMaxMs));
        }
      }

      const doneMsg = `Broadcast complete: delivered safely to ${sent}/${targetJids.length} groups (cap ${cfg.maxBroadcastTargets}).`;
      await ctx.reply(doneMsg);
      return doneMsg;
    },
  },
  {
    name: 'autoread',
    aliases: ['autoseen', 'autoblue', 'autoviewmsg'],
    category: 'owner',
    description: 'Incoming messages ko auto-seen (blue tick) on/off kare',
    usage: 'autoread <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Auto-Read Messages is currently *${cfg.autoReadMessages ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}autoread on\` or \`${ctx.prefix}autoread off\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ autoReadMessages: arg === 'on' });
      const msg = `Auto-Read (Auto-Seen Messages) turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'autostatus',
    aliases: ['statusseen', 'autoviewstatus', 'autosview'],
    category: 'owner',
    description: 'WhatsApp statuses ko automatic seen/view karne ka toggle',
    usage: 'autostatus <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Auto-Status Seen is currently *${cfg.autoStatusSeen ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}autostatus on\` or \`${ctx.prefix}autostatus off\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ autoStatusSeen: arg === 'on' });
      const msg = `Auto-Status Seen turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'autotyping',
    aliases: ['typing'],
    category: 'owner',
    description: 'Har incoming message par automatic typing... show karne ka toggle',
    usage: 'autotyping <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Auto-Typing is currently *${cfg.autoTyping ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}autotyping on\` or \`${ctx.prefix}autotyping off\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ autoTyping: arg === 'on' });
      const msg = `Auto-Typing turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'autorecord',
    aliases: ['autorecording', 'recording'],
    category: 'owner',
    description: 'Har incoming message par automatic recording audio... show karne ka toggle',
    usage: 'autorecord <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Auto-Recording is currently *${cfg.autoRecording ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}autorecord on\` or \`${ctx.prefix}autorecord off\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ autoRecording: arg === 'on' });
      const msg = `Auto-Recording turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'opengc',
    aliases: ['ibsend', 'sendopen', 'encrypt', 'locksend', 'autoshare'],
    category: 'owner',
    description: 'Link ya text ko sab Open GCs mein bheje (Admin Anti-Delete Lock ke sath)',
    usage: 'opengc <text / link> (or reply to message)',
    ownerOnly: true,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';
      const payload = ctx.text.trim() || quotedText;

      if (!payload) {
        const msg = [
          `*Protected Open-GC Dispatch*`,
          `• Send a link/message to ALL Open GCs (auto-reposts if an admin deletes it):`,
          `  \`${ctx.prefix}opengc https://chat.whatsapp.com/...\``,
          `• Auto-forward anything you send in your IB: \`${ctx.prefix}ibpost on\``,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated Open-GC Lock] Protected message queued for all Open GCs:\n"${payload}"`;
        await ctx.reply(msg);
        return msg;
      }

      const result = await dispatchOpenGcProtectedPost(ctx.sock, payload);
      const msg =
        result.totalOpen === 0
          ? 'No open WhatsApp groups found right now.'
          : `Delivered to *${result.sent}/${result.totalOpen}* Open Group(s) with Anti-Delete Lock (auto-restores if deleted).`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'ibpost',
    aliases: ['ibforward', 'autoopengc'],
    category: 'owner',
    description: 'Apni IB mein likha har link/text automatic sab Open GCs mein bhejne ka toggle',
    usage: 'ibpost <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Auto IB -> Open-GC Forward is currently *${cfg.autoForwardIbToOpenGcs ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}ibpost on\` or \`${ctx.prefix}ibpost off\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ autoForwardIbToOpenGcs: arg === 'on' });
      const msg =
        arg === 'on'
          ? 'Auto IB -> Open-GC Forward turned *ON*! Any link or text you send in your bot IB will automatically go to all Open GCs with Anti-Delete Lock.'
          : 'Auto IB -> Open-GC Forward turned *OFF*.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'autoreact',
    aliases: ['reactauto'],
    category: 'owner',
    description: 'Har incoming message par automatic emoji reaction on/off kare',
    usage: 'autoreact <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Auto-React is currently *${cfg.autoReact ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}autoreact on\` or \`${ctx.prefix}autoreact off\``;
        await ctx.reply(msg);
        return msg;
      }
      saveConfig({ autoReact: arg === 'on' });
      const msg = `Auto-React turned *${arg.toUpperCase()}*${cfg.singleTick && arg === 'on' ? ' (Note: paused while Single Tick Shield is ON)' : ''}.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'ai',
    aliases: ['gpt', 'assistant'],
    category: 'owner',
    description: 'Jis group mein .ai on kare wahan har sawal ka reply kare, ya DM/direct sawal puchhe',
    usage: 'ai <on|off|global on|global off|your question>',
    execute: async (ctx) => {
      const arg0 = ctx.args[0]?.toLowerCase();
      const arg1 = ctx.args[1]?.toLowerCase();
      const cfg = loadConfig();

      if (arg0 === 'global') {
        if (!ctx.isOwner) {
          const msg = `Access Denied: \`${ctx.prefix}ai global\` is restricted to the Bot Owner.`;
          await ctx.reply(msg);
          return msg;
        }
        if (arg1 === 'on' || arg1 === 'off') {
          saveConfig({ aiEnabled: arg1 === 'on' });
          const msg = `DM Global AI Auto-Reply turned *${arg1.toUpperCase()}*.`;
          await ctx.reply(msg);
          return msg;
        }
        const msg = `DM Global AI Auto-Reply is *${cfg.aiEnabled ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}ai global on\` / \`off\``;
        await ctx.reply(msg);
        return msg;
      }

      if (arg0 === 'on' || arg0 === 'off') {
        const enabled = arg0 === 'on';
        if (ctx.isGroup) {
          if (!ctx.isOwner) {
            if (!ctx.sock || ctx.isSimulated) {
              const msg = 'Group Admin or Owner permission required.';
              await ctx.reply(msg);
              return msg;
            }
            const meta = await getCachedGroupMetadata(ctx.sock, ctx.chatId, true);
            const senderP = findParticipant(meta.participants, ctx.senderCandidates || [ctx.senderJid]);
            if (!isParticipantAdmin(senderP)) {
              const msg = 'Only Group Admins or the Bot Owner can toggle AI chat in this group.';
              await ctx.reply(msg);
              return msg;
            }
          }
          vipStore.updateGroupConfig(ctx.chatId, { aiEnabled: enabled });
          const msg = enabled
            ? `Group AI Chat turned *ON* for *this group only*! Every message/question here will now receive an AI reply.`
            : `Group AI Chat turned *OFF* for this group.`;
          await ctx.reply(msg);
          return msg;
        }

        if (!ctx.isOwner) {
          const msg = `Access Denied: DM \`${ctx.prefix}ai ${arg0}\` is restricted to the Bot Owner.`;
          await ctx.reply(msg);
          return msg;
        }
        saveConfig({ aiEnabled: enabled });
        const msg = `DM AI Auto-Replies turned *${arg0.toUpperCase()}* (persisted in database).`;
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.text.trim()) {
        if (ctx.isGroup) {
          const groupCfg = vipStore.getGroupConfig(ctx.chatId);
          const msg = `This Group AI Chat is currently *${groupCfg.aiEnabled ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}ai on\`, \`${ctx.prefix}ai off\`, or \`${ctx.prefix}ai <question>\``;
          await ctx.reply(msg);
          return msg;
        }
        const msg = `DM AI Assistant is currently *${cfg.aiEnabled ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}ai on\`, \`${ctx.prefix}ai off\`, or \`${ctx.prefix}ai <question>\``;
        await ctx.reply(msg);
        return msg;
      }

      try {
        const answer = await generateAiChatReply(ctx.text.trim(), ctx.pushName);
        await ctx.reply(answer);
        return answer;
      } catch (err) {
        const msg = `AI Error: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'singletick',
    aliases: ['stickshield', 'ghosttick'],
    category: 'owner',
    description: 'Single Tick Shield on/off kare (read receipts aur online presence suppress kare)',
    usage: 'singletick <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Single Tick Shield is currently *${cfg.singleTick ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}singletick on\` or \`${ctx.prefix}singletick off\``;
        await ctx.reply(msg);
        return msg;
      }
      const enabled = arg === 'on';
      saveConfig({
        singleTick: enabled,
        ...(enabled ? { autoReadMessages: false } : {}),
      });
      await applySingleTickPresenceAcrossSockets(enabled);
      const msg = enabled
        ? 'Single Tick Shield turned *ON* (read receipts, blue ticks, typing presence & auto-react suppressed).\n_Note: WhatsApp servers still control delivery acknowledgements and suppressing receipts carries ban risk._'
        : 'Single Tick Shield turned *OFF*. Normal presence and read behavior restored.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'restart',
    aliases: ['reboot'],
    category: 'owner',
    description: 'Bot connection aur socket ko clean restart kare',
    usage: 'restart',
    ownerOnly: true,
    execute: async (ctx) => {
      const msg = `Restarting ${loadConfig().botName} socket cleanly...`;
      await ctx.reply(msg);
      setTimeout(() => {
        void import('../handlers/connection.ts').then((m) => m.restartMainBot());
      }, 600);
      return msg;
    },
  },
  {
    name: 'alwaysonline',
    aliases: ['onlinealways', 'keepavailable'],
    category: 'owner',
    description: 'Bot WhatsApp account ko hamesha Online (available) rakhne ka persistent toggle',
    usage: 'alwaysonline <on|off>',
    ownerOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      const cfg = loadConfig();
      if (arg !== 'on' && arg !== 'off') {
        const msg = `Always Online is currently *${cfg.alwaysOnline ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}alwaysonline on\` or \`${ctx.prefix}alwaysonline off\``;
        await ctx.reply(msg);
        return msg;
      }
      const enabled = arg === 'on';
      saveConfig({
        alwaysOnline: enabled,
        ...(enabled && cfg.singleTick ? { singleTick: false } : {}),
      });
      await applyAlwaysOnlinePresenceAcrossSockets(enabled);
      const msg = enabled
        ? `🟢 *Always Online turned ON* — account presence will stay *available* across restarts.`
        : `⚪ *Always Online turned OFF* — presence updated back to normal.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'clearchat',
    aliases: ['wipechat', 'clearmessages'],
    category: 'owner',
    description: 'Current chat ya group ki messages WhatsApp account se clear kare (Baileys chatModify)',
    usage: 'clearchat',
    ownerOnly: true,
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated] Cleared message history for chat ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        const tsNum = Number(ctx.msg?.messageTimestamp || Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000);
        const msgKey = {
          remoteJid: ctx.chatId,
          id: ctx.msg?.key?.id || `CLEAR_${Date.now()}`,
          fromMe: Boolean(ctx.msg?.key?.fromMe),
          ...(ctx.isGroup && !ctx.msg?.key?.fromMe
            ? { participant: ctx.msg?.key?.participant || ctx.senderJid }
            : {}),
        };
        await ctx.sock.chatModify(
          {
            clear: true,
            lastMessages: [
              {
                key: msgKey,
                messageTimestamp: tsNum,
              },
            ],
          },
          ctx.chatId
        );
        const msg = `🧹 *Chat Cleared* for \`${ctx.chatId}\`.`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Failed to clear chat: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'blocklist',
    aliases: ['blocked', 'blklist'],
    category: 'owner',
    description: 'WhatsApp account par tamam blocked contacts ki formatted list dikhaye',
    usage: 'blocklist',
    ownerOnly: true,
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated] Blocked Contacts List (0 total).`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        const rawList = await ctx.sock.fetchBlocklist();
        const jids = Array.from(
          new Set(
            (rawList || []).filter((j): j is string => typeof j === 'string' && j.trim().length > 0)
          )
        );
        if (jids.length === 0) {
          const msg = `📛 *WhatsApp Blocklist*\nNo blocked contacts on this account.`;
          await ctx.reply(msg);
          return msg;
        }

        const formatted: string[] = [];
        for (let i = 0; i < jids.length; i += 1) {
          let bare = normalizeBareJid(jids[i]);
          if (isLidUser(bare) && ctx.sock.signalRepository?.lidMapping?.getPNForLID) {
            try {
              const pn = await ctx.sock.signalRepository.lidMapping.getPNForLID(bare);
              if (pn) bare = normalizeBareJid(pn);
            } catch {
              // Keep original JID if LID lookup unavailable
            }
          }
          const user = jidUserPart(bare);
          const label = bare.endsWith('@s.whatsapp.net') ? `+${normalizePhone(user)}` : bare;
          formatted.push(`${i + 1}. ${label}`);
        }

        const msg = [
          `📛 *WhatsApp Blocklist (${formatted.length})*`,
          ...formatted.slice(0, 80),
          ...(formatted.length > 80 ? [`...and ${formatted.length - 80} more.`] : []),
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Failed to fetch blocklist: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'ban',
    aliases: ['banuser', 'botban'],
    category: 'owner',
    description:
      'Number ya user ko ban kare aur Admin Panel mein add ki gayi multiple Ban reports automatic lagaye',
    usage: 'ban <@user|number|reply> [reason] | .ban list',
    ownerOnly: true,
    execute: async (ctx) => {
      if (ctx.args[0]?.toLowerCase() === 'list') {
        const banned = vipStore.listBannedUsers();
        if (banned.length === 0) {
          const msg = `🚫 *Banned Bot Users (0)*\nNo users are currently banned from bot commands.`;
          await ctx.reply(msg);
          return msg;
        }
        const lines = [
          `🚫 *Banned Bot Users (${banned.length})*`,
          ...banned.slice(0, 60).map(
            (b, i) =>
              `${i + 1}. +${b.number}${b.reason ? ` — _${b.reason}_` : ''} (${b.bannedAt.slice(0, 10)})`
          ),
        ];
        const msg = lines.join('\n');
        await ctx.reply(msg);
        return msg;
      }

      const target = await resolveBanOrUnbanInput(ctx);
      if (!target || (!target.displayPhone && !target.primaryJid)) {
        const msg = `Mention a user, reply to their message, or enter a number.\nUsage: \`${ctx.prefix}ban 923001234567\` or \`${ctx.prefix}ban @user reason\` or \`${ctx.prefix}ban list\``;
        await ctx.reply(msg);
        return msg;
      }

      const cfg = loadConfig();
      const ownerClean = normalizePhone(cfg.ownerNumber);
      const targetNum = target.displayPhone || normalizePhone(jidUserPart(target.primaryJid));
      const botParts = ctx.sock
        ? (await getBotJids(ctx.sock)).map((j) => normalizePhone(jidUserPart(j)))
        : [];

      if (
        (ownerClean && targetNum === ownerClean) ||
        vipStore.isOwner(targetNum) ||
        (targetNum && botParts.includes(targetNum))
      ) {
        const msg = 'Cannot ban or report the Bot Owner or the Bot itself.';
        await ctx.reply(msg);
        return msg;
      }

      const entry = vipStore.banUser({
        number: targetNum || jidUserPart(target.primaryJid),
        jid: target.primaryJid,
        reason: target.reason || undefined,
        bannedBy: ctx.senderNumber,
      });

      const reportLog = await executeMultiReport({
        sock: ctx.sock,
        type: 'ban',
        targetNumber: entry.number,
        targetJid: target.primaryJid,
        reason: entry.reason,
        triggeredBy: ctx.senderNumber || 'owner',
        chatId: ctx.chatId,
        isGroup: ctx.isGroup,
        quotedMsgId: target.quotedMsgId,
        isSimulated: ctx.isSimulated,
      });

      const settings = reportStore.getSettings();
      const lines = [
        `🚫 *Ban & Multi-Report Executed*`,
        `• Target: +${entry.number}`,
        ...(entry.reason ? [`• Reason: ${entry.reason}`] : []),
        `• Bot Status: Persisted in bot ban list`,
        `• Admin Ban Reports Fired: *${reportLog.totalReportsFired}* (${reportLog.templateCount} template${reportLog.templateCount === 1 ? '' : 's'} × ${settings.banRepeatCount}x)`,
        `• WhatsApp Action: ${reportLog.blockActionStatus}${
          reportLog.spamStanzasAttempted > 0
            ? ` · Spam IQ ${reportLog.spamStanzasAccepted}/${reportLog.spamStanzasAttempted}`
            : ''
        }`,
        ...(reportLog.emailsAttempted > 0
          ? [
              `• Support Emails: ${reportLog.emailsSent}/${reportLog.emailsAttempted}${
                reportLog.emailError ? ` (${reportLog.emailError})` : ''
              }`,
            ]
          : []),
      ];

      if (reportLog.totalReportsFired === 0) {
        lines.push(
          '',
          `ℹ️ _No Ban reports added in Admin Panel yet. Open Admin Panel → Ban / Unban Reports to paste your reports._`
        );
      } else if (settings.echoReportsInChat && reportLog.appliedReports.length > 0) {
        lines.push('', `📋 *Applied Ban Reports:*`);
        const maxPreview = Math.min(reportLog.appliedReports.length, 5);
        for (let i = 0; i < maxPreview; i += 1) {
          const r = reportLog.appliedReports[i];
          const snippet = r.body.length > 260 ? `${r.body.slice(0, 260)}...` : r.body;
          lines.push(`*${i + 1}. ${r.title}:*\n${snippet}`);
        }
        if (reportLog.appliedReports.length > maxPreview) {
          lines.push(`_...and ${reportLog.appliedReports.length - maxPreview} more report(s) applied._`);
        }
      }

      const text = lines.join('\n');
      logger.security(
        'owner',
        `Banned +${entry.number} & executed ${reportLog.totalReportsFired} report(s)`
      );

      if (ctx.sock && !ctx.isSimulated && target.primaryJid && ctx.isGroup) {
        await ctx.sock.sendMessage(
          ctx.chatId,
          { text, mentions: [target.primaryJid] },
          { quoted: ctx.msg ?? undefined }
        );
      } else {
        await ctx.reply(text);
      }
      return text;
    },
  },
  {
    name: 'unban',
    aliases: ['unbanuser', 'botunban'],
    category: 'owner',
    description:
      'Kisi bhi banned number par Admin Panel mein add ki gayi multiple Unban reports lagaye aur bot ban list se remove kare',
    usage: 'unban <@user|number|reply> [note]',
    ownerOnly: true,
    execute: async (ctx) => {
      const target = await resolveBanOrUnbanInput(ctx);

      if (!target || (!target.displayPhone && !target.primaryJid)) {
        const msg = `Mention a user, reply to their message, or enter a number.\nUsage: \`${ctx.prefix}unban 923001234567\` or \`${ctx.prefix}unban @user\``;
        await ctx.reply(msg);
        return msg;
      }

      const candidates = Array.from(
        new Set([target.displayPhone, target.primaryJid, ...target.candidates].filter(Boolean))
      );
      const removed = vipStore.unbanUser(candidates);
      const label = removed?.number || target.displayPhone || jidUserPart(target.primaryJid);

      const reportLog = await executeMultiReport({
        sock: ctx.sock,
        type: 'unban',
        targetNumber: label,
        targetJid: target.primaryJid,
        reason: target.reason || undefined,
        triggeredBy: ctx.senderNumber || 'owner',
        chatId: ctx.chatId,
        isGroup: ctx.isGroup,
        quotedMsgId: target.quotedMsgId,
        isSimulated: ctx.isSimulated,
      });

      const settings = reportStore.getSettings();
      const lines = [
        `✅ *Unban Multi-Report Executed*`,
        `• Target: +${label}`,
        `• Bot Ban List: ${
          removed
            ? 'Removed from local bot ban list'
            : 'Not in local bot list (Unban reports applied)'
        }`,
        `• Admin Unban Reports Fired: *${reportLog.totalReportsFired}* (${reportLog.templateCount} template${reportLog.templateCount === 1 ? '' : 's'} × ${settings.unbanRepeatCount}x)`,
        `• WhatsApp Action: ${reportLog.blockActionStatus}`,
        ...(reportLog.emailsAttempted > 0
          ? [
              `• Support Emails: ${reportLog.emailsSent}/${reportLog.emailsAttempted}${
                reportLog.emailError ? ` (${reportLog.emailError})` : ''
              }`,
            ]
          : []),
      ];

      if (reportLog.totalReportsFired === 0) {
        lines.push(
          '',
          `ℹ️ _No Unban reports added in Admin Panel yet. Open Admin Panel → Ban / Unban Reports to paste your unban reports._`
        );
      } else if (settings.echoReportsInChat && reportLog.appliedReports.length > 0) {
        lines.push('', `📋 *Applied Unban Reports:*`);
        const maxPreview = Math.min(reportLog.appliedReports.length, 5);
        for (let i = 0; i < maxPreview; i += 1) {
          const r = reportLog.appliedReports[i];
          const snippet = r.body.length > 260 ? `${r.body.slice(0, 260)}...` : r.body;
          lines.push(`*${i + 1}. ${r.title}:*\n${snippet}`);
        }
        if (reportLog.appliedReports.length > maxPreview) {
          lines.push(`_...and ${reportLog.appliedReports.length - maxPreview} more unban report(s) applied._`);
        }
      }

      const text = lines.join('\n');
      logger.info(
        'owner',
        `Unban reports executed for +${label} (${reportLog.totalReportsFired} report(s))`
      );

      if (ctx.sock && !ctx.isSimulated && target.primaryJid && ctx.isGroup) {
        await ctx.sock.sendMessage(
          ctx.chatId,
          { text, mentions: [target.primaryJid] },
          { quoted: ctx.msg ?? undefined }
        );
      } else {
        await ctx.reply(text);
      }
      return text;
    },
  },
  {
    name: 'antivirus',
    aliases: ['anticrash', 'antibug', 'zeroday', 'crashshield'],
    category: 'owner',
    description: 'Zero-Day Crash, Invisible Unicode Bomb & Anti-Virus Shield control aur blacklist manage kare',
    usage: 'antivirus <on|off|global on|global off|list|unblock @user>',
    execute: async (ctx) => {
      const arg0 = ctx.args[0]?.toLowerCase() || '';
      const arg1 = ctx.args[1]?.toLowerCase() || '';
      const cfg = loadConfig();

      if (arg0 === 'global') {
        if (!ctx.isOwner) {
          const msg = `Access Denied: \`${ctx.prefix}antivirus global\` is restricted to the Bot Owner.`;
          await ctx.reply(msg);
          return msg;
        }
        if (arg1 === 'on' || arg1 === 'off') {
          const enabled = arg1 === 'on';
          saveConfig({ antiVirusGlobal: enabled });
          logger.security('crashGuard', `Global Anti-Virus & Zero-Day Shield turned ${enabled ? 'ON' : 'OFF'}`);
          const msg = `🛡️ *Global Anti-Virus & Zero-Day Shield turned ${enabled ? 'ON' : 'OFF'}*\n• Owner & VIP Private IBs remain protected and attackers are auto-blacklisted.`;
          await ctx.reply(msg);
          return msg;
        }
        const msg = `Global Anti-Virus Shield is *${cfg.antiVirusGlobal ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}antivirus global on\` / \`off\``;
        await ctx.reply(msg);
        return msg;
      }

      if (arg0 === 'list' || arg0 === 'threats' || arg0 === 'incidents') {
        if (!ctx.isOwner) {
          const msg = `Access Denied: \`${ctx.prefix}antivirus ${arg0}\` is restricted to the Bot Owner.`;
          await ctx.reply(msg);
          return msg;
        }
        const blocked = crashGuardStore.listBlacklist();
        const incidents = crashGuardStore.listIncidents(10);
        const lines = [
          `🛡️ *Anti-Virus Threat Blacklist (${blocked.length})*`,
          ...(blocked.length === 0
            ? ['  _No blacklisted crash attackers right now._']
            : blocked
                .slice(0, 30)
                .map(
                  (b, i) =>
                    `  ${i + 1}. +${b.number} — *${b.categories.join(', ')}* (${b.hits}x · ${b.blockedAt.slice(0, 10)})`
                )),
          ...(incidents.length > 0
            ? [
                '',
                `📋 *Recent Neutralized Attacks (${incidents.length}):*`,
                ...incidents
                  .slice(0, 5)
                  .map(
                    (inc) =>
                      `  • [${inc.scope.toUpperCase()}] +${inc.attackerNumber}: ${inc.categories.join(', ')}`
                  ),
              ]
            : []),
        ];
        const msg = lines.join('\n');
        await ctx.reply(msg);
        return msg;
      }

      if (arg0 === 'unblock' || arg0 === 'unban' || arg0 === 'remove' || arg0 === 'clear') {
        if (!ctx.isOwner) {
          const msg = `Access Denied: \`${ctx.prefix}antivirus ${arg0}\` is restricted to the Bot Owner.`;
          await ctx.reply(msg);
          return msg;
        }
        const subArgs = ctx.args.slice(1);
        const target = await resolveDmOrMentionTarget({ ...ctx, args: subArgs });
        if (!target) {
          const msg = `Mention a user, reply, or pass a number.\nUsage: \`${ctx.prefix}antivirus unblock @user\``;
          await ctx.reply(msg);
          return msg;
        }
        const candidates = Array.from(
          new Set([target.displayPhone, target.primaryJid, ...target.candidates].filter(Boolean))
        );
        const removed = crashGuardStore.removeFromBlacklist(candidates);
        vipStore.unbanUser(candidates);
        anticallStore.unblockCaller(candidates);
        if (ctx.sock && !ctx.isSimulated && target.primaryJid) {
          await ctx.sock.updateBlockStatus(target.primaryJid, 'unblock').catch(() => {});
        }
        const label = removed?.number || target.displayPhone || jidUserPart(target.primaryJid);
        const msg = removed
          ? `✅ *Removed from Anti-Virus Blacklist:* +${label} has been unblacklisted & unblocked.`
          : `ℹ️ +${label} was not in the Anti-Virus blacklist (WhatsApp unblock attempted).`;
        await ctx.reply(msg);
        return msg;
      }

      if (arg0 === 'on' || arg0 === 'off') {
        const enabled = arg0 === 'on';
        if (ctx.isGroup) {
          if (!ctx.isOwner) {
            if (!ctx.sock || ctx.isSimulated) {
              const msg = 'Group Admin or Owner permission required.';
              await ctx.reply(msg);
              return msg;
            }
            const meta = await getCachedGroupMetadata(ctx.sock, ctx.chatId, true);
            const senderP = findParticipant(meta.participants, ctx.senderCandidates || [ctx.senderJid]);
            if (!isParticipantAdmin(senderP)) {
              const msg = 'Only Group Admins or the Bot Owner can toggle Anti-Virus Crash Shield in this group.';
              await ctx.reply(msg);
              return msg;
            }
          }
          vipStore.updateGroupConfig(ctx.chatId, { antiVirus: enabled });
          const msg = enabled
            ? `🛡️ *Group Anti-Virus & Zero-Day Shield turned ON!*\nInvisible unicode bombs, malformed protobuf crashes, and exploit payloads will be neutralized, with attackers kicked & blacklisted.`
            : `⚪ *Group Anti-Virus Shield turned OFF* for this group.`;
          await ctx.reply(msg);
          return msg;
        }

        if (!ctx.isOwner) {
          const msg = `Access Denied: Global \`${ctx.prefix}antivirus ${arg0}\` is restricted to the Bot Owner.`;
          await ctx.reply(msg);
          return msg;
        }
        saveConfig({ antiVirusGlobal: enabled });
        const msg = `🛡️ *Global Anti-Virus & Zero-Day Shield turned ${arg0.toUpperCase()}*.`;
        await ctx.reply(msg);
        return msg;
      }

      const blacklistedCount = crashGuardStore.listBlacklist().length;
      const recentCount = crashGuardStore.listIncidents(50).length;
      const groupCfg = ctx.isGroup ? vipStore.getGroupConfig(ctx.chatId) : null;
      const msg = [
        `🛡️ *Anti-Virus & Zero-Day Crash Protection*`,
        `• Global / DM Shield: *${cfg.antiVirusGlobal ? 'ON' : 'OFF'}*`,
        `• Owner & VIP IB Shield: *ACTIVE (Always Protected)*`,
        ...(groupCfg ? [`• This Group Shield: *${groupCfg.antiVirus ? 'ON' : 'OFF'}*`] : []),
        `• Blacklisted Attackers: *${blacklistedCount}*`,
        `• Neutralized Attacks Logged: *${recentCount}*`,
        '',
        `Usage:`,
        `• \`${ctx.prefix}antivirus on\` / \`off\` — Toggle in current group (or global for Owner DM)`,
        `• \`${ctx.prefix}antivirus global on\` / \`off\` — Toggle global shield`,
        `• \`${ctx.prefix}antivirus list\` — View blacklisted attackers & incidents`,
        `• \`${ctx.prefix}antivirus unblock @user\` — Unblacklist & unblock a user`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
];
