import {
  generateWAMessageContent,
  generateWAMessageFromContent,
  getUrlInfo,
  proto,
  type AnyMessageContent,
  type GroupParticipant,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { isValidPhone, loadConfig, normalizePhone, saveConfig } from '../config/bot.config.ts';
import { normalizeFileSha256 } from '../handlers/group.ts';
import {
  extractContextInfo,
  extractFirstUrl,
  extractRawTargetCandidates,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  hasValidMediaPayload,
  invalidateGroupMetadataCache,
  isLidUser,
  isParticipantAdmin,
  jidUserPart,
  normalizeBareJid,
  resolveGroupTargetJids,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import {
  detectMediaType,
  downloadMessageMedia,
  extractQuotedMessage,
} from '../utils/mediaHelper.ts';
import { commandRateLimiter } from '../utils/rateLimiter.ts';
import { formatDurationHuman, parseDurationMs } from '../utils/reminderStore.ts';
import { vipStore } from '../utils/vipStore.ts';
import type { BotCommand, CommandContext } from './types.ts';

function checkTagSafety(ctx: CommandContext): { allowed: boolean; reason?: string } {
  const cfg = loadConfig();
  const cd = commandRateLimiter.checkCooldown(`tag-cd:${ctx.chatId}`, cfg.tagCooldownSeconds);
  if (!cd.allowed) {
    logger.warn(
      'safetyGuard',
      `Tag/mention cooldown blocked in ${ctx.chatId} (${cd.retryAfterSeconds}s remaining)`
    );
    return {
      allowed: false,
      reason: `Tag safety cooldown active. Wait ${cd.retryAfterSeconds}s before mentioning all members again.`,
    };
  }
  const hourly = commandRateLimiter.check(`tag-hr:${ctx.chatId}`, cfg.tagMaxPerHour, 60, 60);
  if (!hourly.allowed) {
    logger.security(
      'safetyGuard',
      `Hourly mention cap (${cfg.tagMaxPerHour}/hr) reached in ${ctx.chatId}`
    );
    return {
      allowed: false,
      reason: `Hourly mention limit (${cfg.tagMaxPerHour}/hr) reached for this group. Retry in ${hourly.retryAfterSeconds}s.`,
    };
  }
  return { allowed: true };
}

async function verifyGroupAdmins(
  ctx: CommandContext,
  options: { requireBotAdmin?: boolean; targetGroupId?: string } = { requireBotAdmin: true }
): Promise<{
  ok: boolean;
  reason?: string;
  botIsAdmin: boolean;
  participants: GroupParticipant[];
}> {
  if (!ctx.sock || ctx.isSimulated) {
    return {
      ok: false,
      reason: 'Group admin actions require a live WhatsApp group chat.',
      botIsAdmin: false,
      participants: [],
    };
  }

  const groupId = options.targetGroupId || ctx.chatId;
  let participants: GroupParticipant[] = [];
  try {
    const meta = await getCachedGroupMetadata(ctx.sock, groupId);
    participants = meta.participants || [];
  } catch (err) {
    return {
      ok: false,
      reason: `Could not fetch group info from WhatsApp: ${(err as Error).message}`,
      botIsAdmin: false,
      participants: [],
    };
  }

  const botJids = await getBotJids(ctx.sock);
  const botParticipant = findParticipant(participants, botJids);
  const botIsAdmin = isParticipantAdmin(botParticipant);

  const senderCandidates =
    ctx.senderCandidates && ctx.senderCandidates.length > 0
      ? ctx.senderCandidates
      : [ctx.senderJid, `${ctx.senderNumber}@s.whatsapp.net`];
  const senderParticipant = findParticipant(participants, senderCandidates);
  const senderIsAdmin = isParticipantAdmin(senderParticipant) || ctx.isOwner;

  if (!senderIsAdmin) {
    return {
      ok: false,
      reason: 'Only Group Admins or Bot Owner can run this command.',
      botIsAdmin,
      participants,
    };
  }

  if (options.requireBotAdmin !== false && !botIsAdmin) {
    return {
      ok: false,
      reason: 'Please promote the bot to Group Admin first.',
      botIsAdmin,
      participants,
    };
  }

  return { ok: true, botIsAdmin, participants };
}

export const groupCommands: BotCommand[] = [
  {
    name: 'kick',
    aliases: ['remove', 'out'],
    category: 'group',
    description: 'Member ko group se remove kare (@mention, reply, ya number)',
    usage: 'kick @user / reply',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }

      const rawTargets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targets = resolveGroupTargetJids(check.participants, rawTargets);
      if (targets.length === 0) {
        const msg = `Mention a member, reply to their message, or pass a number.\nUsage: \`${ctx.prefix}kick @user\``;
        await ctx.reply(msg);
        return msg;
      }

      const botJids = await getBotJids(ctx.sock!);
      const botParticipant = findParticipant(check.participants, botJids);
      const filteredTargets = targets.filter((t) => t !== botParticipant?.id && !botJids.includes(t));
      if (filteredTargets.length === 0) {
        const msg = 'Cannot kick the bot itself.';
        await ctx.reply(msg);
        return msg;
      }

      try {
        await ctx.sock!.groupParticipantsUpdate(ctx.chatId, filteredTargets, 'remove');
        invalidateGroupMetadataCache(ctx.chatId);
        const msg = `Removed ${filteredTargets.map((j) => `@${jidUserPart(j)}`).join(', ')} from the group.`;
        await ctx.sock!.sendMessage(ctx.chatId, { text: msg, mentions: filteredTargets });
        return msg;
      } catch (err) {
        const msg = `Kick failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'add',
    aliases: ['invite'],
    category: 'group',
    description: 'Phone number ko group mein add kare (privacy invite fallback ke sath)',
    usage: 'add <number>',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const num = normalizePhone(ctx.args[0] || '');
      if (!isValidPhone(num)) {
        const msg = `Usage: \`${ctx.prefix}add 923169760375\``;
        await ctx.reply(msg);
        return msg;
      }
      const jid = `${num}@s.whatsapp.net`;
      try {
        const res = await ctx.sock!.groupParticipantsUpdate(ctx.chatId, [jid], 'add');
        invalidateGroupMetadataCache(ctx.chatId);
        const status = String((res?.[0] as { status?: string })?.status || '200');
        if (status === '403' || status === '408' || status === '409') {
          if (status === '409') {
            const msg = `+${num} is already in this group.`;
            await ctx.reply(msg);
            return msg;
          }
          const inviteCode = await ctx.sock!.groupInviteCode(ctx.chatId);
          const link = `https://chat.whatsapp.com/${inviteCode}`;
          await ctx.sock!.sendMessage(jid, { text: `You were invited to join the group:\n${link}` });
          const msg = `User privacy restricts direct add. Sent group invite link to +${num}.`;
          await ctx.reply(msg);
          return msg;
        }
        const msg = `Added +${num} to the group.`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Add failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'promote',
    category: 'group',
    description: 'Group member ko admin banaye',
    usage: 'promote @user / reply',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const rawTargets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targets = resolveGroupTargetJids(check.participants, rawTargets);
      if (targets.length === 0) {
        const msg = `Mention or reply to the member to promote.`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        await ctx.sock!.groupParticipantsUpdate(ctx.chatId, targets, 'promote');
        invalidateGroupMetadataCache(ctx.chatId);
        const msg = `Promoted ${targets.map((j) => `@${jidUserPart(j)}`).join(', ')} to Group Admin.`;
        await ctx.sock!.sendMessage(ctx.chatId, { text: msg, mentions: targets });
        return msg;
      } catch (err) {
        const msg = `Promote failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'demote',
    category: 'group',
    description: 'Admin ko normal group member banaye',
    usage: 'demote @user / reply',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const rawTargets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targets = resolveGroupTargetJids(check.participants, rawTargets);
      if (targets.length === 0) {
        const msg = `Mention or reply to the admin to demote.`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        await ctx.sock!.groupParticipantsUpdate(ctx.chatId, targets, 'demote');
        invalidateGroupMetadataCache(ctx.chatId);
        const msg = `Demoted ${targets.map((j) => `@${jidUserPart(j)}`).join(', ')} to regular member.`;
        await ctx.sock!.sendMessage(ctx.chatId, { text: msg, mentions: targets });
        return msg;
      } catch (err) {
        const msg = `Demote failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'tagall',
    aliases: ['everyone'],
    category: 'group',
    description: 'Sab group members ko clean formatted list mein mention kare',
    usage: 'tagall [message]',
    groupOnly: true,
    execute: async (ctx) => {
      const safety = checkTagSafety(ctx);
      if (!safety.allowed) {
        await ctx.reply(safety.reason!);
        return safety.reason!;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated TagAll] Announcement: ${ctx.text || 'Attention all members!'}`;
        await ctx.reply(msg);
        return msg;
      }
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const mentions = check.participants.map((p) => p.id);
      const header = ctx.text
        ? `*Announcement:* ${ctx.text}\n\n`
        : `*Group Mention (${mentions.length} Members)*\n\n`;
      const body = mentions.map((j, i) => `${i + 1}. @${jidUserPart(j)}`).join('\n');
      await ctx.sock.sendMessage(ctx.chatId, { text: header + body, mentions });
      return `Tagged ${mentions.length} members.`;
    },
  },
  {
    name: 'hidetag',
    aliases: ['htag', 'tag'],
    category: 'group',
    description: 'Sab members ko hidden mention notification bheje',
    usage: 'hidetag <text>',
    groupOnly: true,
    execute: async (ctx) => {
      const safety = checkTagSafety(ctx);
      if (!safety.allowed) {
        await ctx.reply(safety.reason!);
        return safety.reason!;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated HideTag] ${ctx.text || 'Important notice'}`;
        await ctx.reply(msg);
        return msg;
      }
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const mentions = check.participants.map((p) => p.id);
      const text = ctx.text || 'Group Notification';
      await ctx.sock.sendMessage(ctx.chatId, { text, mentions });
      return `Sent hidden tag to ${mentions.length} members.`;
    },
  },
  {
    name: 'gclist',
    aliases: ['grouplist', 'gcs'],
    category: 'group',
    description: 'Sab joined WhatsApp groups ki numbered list & JID show kare',
    usage: 'gclist',
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = '[Simulated GC List] Run `.gclist` on WhatsApp to view live joined groups with numbers.';
        await ctx.reply(msg);
        return msg;
      }
      const groupsMap = await ctx.sock.groupFetchAllParticipating();
      const entries = Object.values(groupsMap);
      if (entries.length === 0) {
        const msg = 'No joined WhatsApp groups found.';
        await ctx.reply(msg);
        return msg;
      }
      const lines = entries.slice(0, 40).map(
        (g, idx) => `${idx + 1}. *${g.subject || 'Unnamed Group'}* (${g.participants?.length || 0} members)\n   JID: \`${g.id}\``
      );
      const msg = [
        `*${loadConfig().botName} — Joined Groups (${entries.length})*`,
        '',
        ...lines,
        '',
        `Use \`${ctx.prefix}gcstatus 1 | Your status text\` to post an auto-removing status on any GC.`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'gcstatus',
    aliases: ['statusgc', 'gstatus', 'gcst'],
    category: 'group',
    description: 'Kisi bhi GC par auto-removing Group Status lagaye (text, image, video, audio)',
    usage: 'gcstatus [index|groupJid |] [15s|keep |] <text / reply media>',
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated GC Status] Auto-removing status scheduled: ${ctx.text || 'Media Status'}`;
        await ctx.reply(msg);
        return msg;
      }

      let rawBody = ctx.text.trim();
      let targetGroupJid = ctx.isGroup ? ctx.chatId : '';
      let autoRemoveSec = 0; // Default 0 = stays 24 hours on WhatsApp (no 15s auto-delete)

      // Parse optional target group via `1 | text` or `120363...@g.us | text`
      if (rawBody.includes('|')) {
        const [left, ...rest] = rawBody.split('|');
        const targetSpec = left.trim();
        rawBody = rest.join('|').trim();

        if (/^\d{1,3}s$/i.test(targetSpec)) {
          autoRemoveSec = Math.max(3, Math.min(300, Number(targetSpec.slice(0, -1))));
        } else if (targetSpec.toLowerCase() === 'keep' || targetSpec.toLowerCase() === '24h') {
          autoRemoveSec = 0;
        } else if (targetSpec.endsWith('@g.us')) {
          targetGroupJid = targetSpec;
        } else if (/^\d+$/.test(targetSpec)) {
          const idx = Number(targetSpec) - 1;
          const groupsMap = await ctx.sock.groupFetchAllParticipating();
          const allGroups = Object.values(groupsMap);
          if (allGroups[idx]) {
            targetGroupJid = allGroups[idx].id;
          } else {
            const msg = `Group #${targetSpec} not found. Run \`${ctx.prefix}gclist\` to see valid group numbers.`;
            await ctx.reply(msg);
            return msg;
          }
        } else if (targetSpec) {
          const groupsMap = await ctx.sock.groupFetchAllParticipating();
          const matched = Object.values(groupsMap).find((g) =>
            (g.subject || '').toLowerCase().includes(targetSpec.toLowerCase())
          );
          if (matched) {
            targetGroupJid = matched.id;
          } else {
            const msg = `No group matched "${targetSpec}". Run \`${ctx.prefix}gclist\` to see groups.`;
            await ctx.reply(msg);
            return msg;
          }
        }
      } else if (!ctx.isGroup && ctx.args[0]) {
        const first = ctx.args[0];
        if (first.endsWith('@g.us')) {
          targetGroupJid = first;
          rawBody = ctx.text.slice(first.length).trim();
        } else if (/^\d{1,3}$/.test(first)) {
          const idx = Number(first) - 1;
          const groupsMap = await ctx.sock.groupFetchAllParticipating();
          const allGroups = Object.values(groupsMap);
          if (allGroups[idx]) {
            targetGroupJid = allGroups[idx].id;
            rawBody = ctx.text.slice(first.length).trim();
          }
        }
      }

      // Parse optional leading duration token like `10s | text` or `keep`
      const firstToken = rawBody.split(/\s+/)[0]?.toLowerCase() || '';
      if (/^\d{1,3}s$/.test(firstToken)) {
        autoRemoveSec = Math.max(3, Math.min(300, Number(firstToken.slice(0, -1))));
        rawBody = rawBody.slice(firstToken.length).replace(/^\s*\|\s*/, '').trim();
      } else if (firstToken === 'keep' || firstToken === '24h') {
        autoRemoveSec = 0;
        rawBody = rawBody.slice(firstToken.length).replace(/^\s*\|\s*/, '').trim();
      }

      // Resolve target list: either single group OR all Open GCs when run from Owner's IB/DM
      let targetGroupIds: string[] = [];
      if (targetGroupJid && targetGroupJid.endsWith('@g.us')) {
        const adminCheck = await verifyGroupAdmins(ctx, {
          requireBotAdmin: false,
          targetGroupId: targetGroupJid,
        });
        if (!adminCheck.ok) {
          await ctx.reply(adminCheck.reason!);
          return adminCheck.reason!;
        }
        targetGroupIds = [targetGroupJid];
      } else if (!ctx.isGroup) {
        if (!ctx.isOwner) {
          const msg = 'Only Bot Owner can post GC Status to all open groups from DM/IB.';
          await ctx.reply(msg);
          return msg;
        }
        const groupsMap = await ctx.sock.groupFetchAllParticipating();
        targetGroupIds = Object.values(groupsMap)
          .filter((g) => !g.announce && !g.isCommunityAnnounce)
          .map((g) => g.id);
        if (targetGroupIds.length === 0) {
          const msg = 'No open WhatsApp groups found. Pass a specific group index like `.gcstatus 1 | text`.';
          await ctx.reply(msg);
          return msg;
        }
      } else {
        const msg = `Provide a link, status text, or reply to media with \`${ctx.prefix}gcstatus\`.`;
        await ctx.reply(msg);
        return msg;
      }

      // Determine payload (text OR replied media)
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const directContent = ctx.msg ? unwrapMessage(ctx.msg.message) : undefined;
      const mediaHolder =
        quoted && detectMediaType(quoted) !== 'unknown'
          ? quoted
          : directContent && detectMediaType(directContent) !== 'unknown'
            ? directContent
            : null;
      const mediaType = mediaHolder ? detectMediaType(mediaHolder) : 'unknown';

      let anyContent: AnyMessageContent | null = null;
      if (mediaHolder && (mediaType === 'image' || mediaType === 'video' || mediaType === 'audio')) {
        if (!hasValidMediaPayload(mediaHolder)) {
          const msg = 'Media payload unavailable. Resend the photo/video/audio and reply with `.gcstatus`.';
          await ctx.reply(msg);
          return msg;
        }
        const mediaBuf = await downloadMessageMedia(ctx.sock, {
          key: ctx.msg!.key,
          message: mediaHolder,
        } as WAMessage);

        if (mediaType === 'image') {
          anyContent = { image: mediaBuf, caption: rawBody || undefined };
        } else if (mediaType === 'video') {
          anyContent = { video: mediaBuf, caption: rawBody || undefined };
        } else {
          anyContent = { audio: mediaBuf, mimetype: 'audio/mp4', ptt: false };
        }
      } else if (rawBody) {
        const firstUrl = extractFirstUrl(rawBody);
        if (firstUrl) {
          const urlInfo = await getUrlInfo(rawBody, {
            thumbnailWidth: 192,
            fetchOpts: { timeout: 3500 },
            uploadImage: ctx.sock.waUploadToServer,
          }).catch(() => undefined);
          anyContent = urlInfo
            ? { text: rawBody, linkPreview: urlInfo }
            : { text: rawBody };
        } else {
          anyContent = { text: rawBody };
        }
      } else {
        const msg = `Provide a link, status text, or reply to an image/video/audio with \`${ctx.prefix}gcstatus\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const innerContent = await generateWAMessageContent(anyContent, {
        upload: ctx.sock.waUploadToServer,
      });

      let postedCount = 0;
      const ownerFallbackJid = `${loadConfig().ownerNumber}@s.whatsapp.net`;
      for (let i = 0; i < targetGroupIds.length; i += 1) {
        const gid = targetGroupIds[i];
        let sentKey: WAMessage['key'] | undefined;
        try {
          const built = generateWAMessageFromContent(
            gid,
            { groupStatusMessageV2: { message: innerContent } },
            { userJid: ctx.sock.user?.id || ownerFallbackJid }
          );
          await ctx.sock.relayMessage(gid, built.message!, {
            messageId: built.key.id!,
          });
          sentKey = built.key;
          postedCount += 1;
        } catch {
          try {
            const sent = await ctx.sock.sendMessage(gid, anyContent);
            sentKey = sent?.key;
            postedCount += 1;
          } catch {
            // Skip failed group
          }
        }

        if (autoRemoveSec > 0 && sentKey) {
          const sockRef = ctx.sock;
          const keyToDelete = sentKey;
          setTimeout(() => {
            void sockRef.sendMessage(gid, { delete: keyToDelete }).catch(() => {});
          }, autoRemoveSec * 1000);
        }

        if (i < targetGroupIds.length - 1) {
          await new Promise((r) => setTimeout(r, 350));
        }
      }

      if (targetGroupIds.length === 1) {
        const gid = targetGroupIds[0];
        const meta = await getCachedGroupMetadata(ctx.sock, gid).catch(() => null);
        const gcName = meta?.subject || gid;
        const doneMsg =
          autoRemoveSec > 0
            ? `GC Status posted on *${gcName}*! It will auto-remove in *${autoRemoveSec}s*.`
            : `24-hour GC Status posted on *${gcName}*!`;
        await ctx.reply(doneMsg);
        return doneMsg;
      }

      const doneMsg =
        autoRemoveSec > 0
          ? `GC Status posted on *${postedCount}/${targetGroupIds.length}* Open Group(s) (removes in *${autoRemoveSec}s*).`
          : `24-hour GC Status posted on *${postedCount}/${targetGroupIds.length}* Open Group(s)!`;
      await ctx.reply(doneMsg);
      return doneMsg;
    },
  },
  {
    name: 'antilink',
    category: 'group',
    description: '3-mode Antilink: delete only, 3-warning auto-kick, ya instant kick',
    usage: 'antilink <delete|warn|kick|off>',
    groupOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      if (arg !== 'on' && arg !== 'off' && arg !== 'kick' && arg !== 'delete' && arg !== 'warn') {
        const cfg = vipStore.getGroupConfig(ctx.chatId);
        const mode = cfg.antilinkMode || (cfg.antilink ? 'delete' : 'off');
        const statusLabel =
          !cfg.antilink || mode === 'off'
            ? 'OFF'
            : mode === 'kick'
              ? 'KICK (Instant Remove)'
              : mode === 'warn'
                ? 'WARN (3 Warnings -> Auto Remove)'
                : 'DELETE ONLY';
        const msg = [
          `Antilink is currently *${statusLabel}*.`,
          `Usage:`,
          `• \`${ctx.prefix}antilink delete\` (or \`on\`) — Only delete links`,
          `• \`${ctx.prefix}antilink warn\` — Delete link + 3 warnings before auto-kick`,
          `• \`${ctx.prefix}antilink kick\` — Delete link & instant kick`,
          `• \`${ctx.prefix}antilink off\` — Turn off`,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      let botAdminNote = '';
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
        if (arg !== 'off' && !check.botIsAdmin) {
          botAdminNote = '\n_Note: Promote the bot to Group Admin so it can delete links & remove spammers._';
        }
      }

      if (arg === 'off') {
        vipStore.updateGroupConfig(ctx.chatId, { antilink: false, antilinkMode: 'off' });
        const msg = 'Group Antilink protection turned *OFF*.';
        await ctx.reply(msg);
        return msg;
      }

      const mode = arg === 'kick' ? 'kick' : arg === 'warn' ? 'warn' : 'delete';
      vipStore.updateGroupConfig(ctx.chatId, { antilink: true, antilinkMode: mode });
      const msg =
        mode === 'kick'
          ? `Group Antilink turned *ON (Auto-Delete + Instant Kick)*.${botAdminNote}`
          : mode === 'warn'
            ? `Group Antilink turned *ON (Auto-Delete + 3 Warnings -> Auto Kick)*.${botAdminNote}`
            : `Group Antilink turned *ON (Only Delete Links)*.${botAdminNote}`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'antiscam',
    aliases: ['antispam', 'antigaali', 'antigali'],
    category: 'group',
    description: 'Ghatiya stickers, gaaliyan, scam aur spam messages delete kare (ON/OFF + Global/Strict)',
    usage: 'antiscam <on|off|global on|global off|strict on|strict off>',
    execute: async (ctx) => {
      const sub = ctx.args[0]?.toLowerCase();
      const val = ctx.args[1]?.toLowerCase();

      if (sub === 'global') {
        if (!ctx.isOwner) {
          const msg = 'Only Bot Owner can change Global Anti-Scam mode.';
          await ctx.reply(msg);
          return msg;
        }
        if (val !== 'on' && val !== 'off') {
          const current = loadConfig().antiScamGlobal;
          const msg = `Global Anti-Scam Shield is currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}antiscam global on\` or \`off\``;
          await ctx.reply(msg);
          return msg;
        }
        saveConfig({ antiScamGlobal: val === 'on' });
        const msg = `Global Anti-Scam Shield turned *${val.toUpperCase()}* across default groups (saved in database).`;
        await ctx.reply(msg);
        return msg;
      }

      if (sub === 'strict') {
        if (!ctx.isOwner) {
          const msg = 'Only Bot Owner can change Strict Sticker Anti-Scam mode.';
          await ctx.reply(msg);
          return msg;
        }
        if (val !== 'on' && val !== 'off') {
          const current = loadConfig().antiScamBlockAllStickers;
          const msg = `Strict Sticker Blocker is currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}antiscam strict on\` or \`off\``;
          await ctx.reply(msg);
          return msg;
        }
        saveConfig({ antiScamBlockAllStickers: val === 'on' });
        const msg = `Strict Anti-Scam Sticker Blocker turned *${val.toUpperCase()}* (deletes all non-admin stickers when Anti-Scam is ON).`;
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.isGroup && !ctx.isSimulated) {
        const msg = [
          `*Anti-Scam Shield Commands*`,
          `• In a group: \`${ctx.prefix}antiscam on\` / \`off\``,
          `• Global default: \`${ctx.prefix}antiscam global on\` / \`off\``,
          `• Block all non-admin stickers: \`${ctx.prefix}antiscam strict on\` / \`off\``,
          `• Ban a vulgar sticker: reply to it with \`${ctx.prefix}bansticker\``,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      if (sub !== 'on' && sub !== 'off') {
        const groupCfg = vipStore.getGroupConfig(ctx.chatId);
        const cfg = loadConfig();
        const msg = [
          `*Group Anti-Scam Shield:* *${groupCfg.antiScam ? 'ON' : 'OFF'}*`,
          `• Global Default: *${cfg.antiScamGlobal ? 'ON' : 'OFF'}*`,
          `• Strict Sticker Mode: *${cfg.antiScamBlockAllStickers ? 'ON' : 'OFF'}*`,
          `• Banned Stickers Saved: *${vipStore.listBannedStickers().length}*`,
          ``,
          `Usage: \`${ctx.prefix}antiscam on\` / \`off\` | \`${ctx.prefix}antiscam global on\` | \`${ctx.prefix}bansticker\``,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      let botAdminNote = '';
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
        if (sub === 'on' && !check.botIsAdmin) {
          botAdminNote = '\n_Note: Promote the bot to Group Admin so it can delete bad stickers, gaaliyan & spam._';
        }
      }

      vipStore.updateGroupConfig(ctx.chatId, { antiScam: sub === 'on' });
      const msg =
        sub === 'on'
          ? `Group *Anti-Scam Shield* turned *ON* (Bad stickers, gaaliyan, scams & spam will be auto-deleted; 3 warnings = auto-kick).${botAdminNote}`
          : 'Group *Anti-Scam Shield* turned *OFF*.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'antimention',
    aliases: ['antistatusmention', 'mentionstatus', 'antistatus'],
    category: 'group',
    description: 'Group mein status mention karne walon ke messages auto-delete kare (ON/OFF)',
    usage: 'antimention <on|off|global on|global off>',
    execute: async (ctx) => {
      const sub = ctx.args[0]?.toLowerCase();
      const val = ctx.args[1]?.toLowerCase();

      if (sub === 'global') {
        if (!ctx.isOwner) {
          const msg = 'Only Bot Owner can change Global Anti-Mention Status mode.';
          await ctx.reply(msg);
          return msg;
        }
        if (val !== 'on' && val !== 'off') {
          const current = loadConfig().antiStatusMentionGlobal;
          const msg = `Global Anti-Mention Status is currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}antimention global on\` or \`off\``;
          await ctx.reply(msg);
          return msg;
        }
        saveConfig({ antiStatusMentionGlobal: val === 'on' });
        const msg = `Global Anti-Mention Status turned *${val.toUpperCase()}* (saved in database).`;
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.isGroup && !ctx.isSimulated) {
        const msg = `Use \`${ctx.prefix}antimention on\` / \`off\` inside a group, or \`${ctx.prefix}antimention global on\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (sub !== 'on' && sub !== 'off') {
        const current = vipStore.getGroupConfig(ctx.chatId).antiStatusMention;
        const msg = `Anti-Mention Status is currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}antimention on\` or \`${ctx.prefix}antimention off\``;
        await ctx.reply(msg);
        return msg;
      }

      let botAdminNote = '';
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
        if (sub === 'on' && !check.botIsAdmin) {
          botAdminNote = '\n_Note: Promote the bot to Group Admin so it can delete status mentions._';
        }
      }

      vipStore.updateGroupConfig(ctx.chatId, { antiStatusMention: sub === 'on' });
      const msg =
        sub === 'on'
          ? `Group *Anti-Mention Status* turned *ON* (Status mentions in this group will be deleted).${botAdminNote}`
          : 'Group *Anti-Mention Status* turned *OFF*.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'bansticker',
    aliases: ['blocksticker', 'unbansticker', 'banmedia'],
    category: 'group',
    description: 'Kisi ghatiya sticker, photo ya video par reply karke database mein ban kare',
    usage: 'bansticker [list|unban]',
    execute: async (ctx) => {
      if (ctx.args[0]?.toLowerCase() === 'list') {
        const count = vipStore.listBannedStickers().length;
        const msg = `Total banned stickers/media in database: *${count}*`;
        await ctx.reply(msg);
        return msg;
      }

      if (ctx.isGroup && !ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
      } else if (!ctx.isOwner) {
        const msg = 'Only Bot Owner or Group Admins can ban stickers/media.';
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.msg || ctx.isSimulated) {
        const msg = `Reply to any bad sticker, photo, or video with \`${ctx.prefix}bansticker\` to block it across Anti-Scam groups.`;
        await ctx.reply(msg);
        return msg;
      }

      const quoted = extractQuotedMessage(ctx.msg);
      const targetMedia =
        quoted?.stickerMessage ||
        quoted?.imageMessage ||
        quoted?.videoMessage ||
        quoted?.documentMessage;
      if (!targetMedia) {
        const msg = `Reply to a bad sticker, photo, or video with \`${ctx.prefix}bansticker\` (or \`${ctx.prefix}unbansticker\` to remove).`;
        await ctx.reply(msg);
        return msg;
      }

      const sha = normalizeFileSha256(targetMedia.fileSha256);
      if (!sha) {
        const msg = 'Could not read media hash. Reply to a freshly sent sticker, photo, or video.';
        await ctx.reply(msg);
        return msg;
      }

      if (ctx.commandName === 'unbansticker' || ctx.args[0]?.toLowerCase() === 'off' || ctx.args[0]?.toLowerCase() === 'unban') {
        const removed = vipStore.unbanSticker(sha);
        const msg = removed
          ? 'Media removed from the banned list.'
          : 'This sticker/media was not in the banned list.';
        await ctx.reply(msg);
        return msg;
      }

      vipStore.banSticker(sha, ctx.text || 'Banned by Admin');
      if (ctx.isGroup && ctx.sock) {
        const ctxInfo = ctx.msg.message?.extendedTextMessage?.contextInfo;
        if (ctxInfo?.stanzaId) {
          await ctx.sock
            .sendMessage(ctx.chatId, {
              delete: {
                remoteJid: ctx.chatId,
                fromMe: false,
                id: ctxInfo.stanzaId,
                participant: ctxInfo.participant || undefined,
              },
            })
            .catch(() => {});
        }
      }

      const msg = 'Sticker/Media banned in persistent database! Any member sending it in Anti-Scam groups will have it deleted.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'antidelete',
    category: 'group',
    description: 'Deleted group messages ko auto-recover kare',
    usage: 'antidelete on/off',
    groupOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        const current = vipStore.getGroupConfig(ctx.chatId).antidelete;
        const msg = `Antidelete is currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}antidelete on\` or \`${ctx.prefix}antidelete off\``;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
      }
      vipStore.updateGroupConfig(ctx.chatId, { antidelete: arg === 'on' });
      const msg = `Group Antidelete turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'welcome',
    category: 'group',
    description: 'New member join welcome message on/off kare',
    usage: 'welcome on/off',
    groupOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        const current = vipStore.getGroupConfig(ctx.chatId).welcome;
        const msg = `Welcome messages are currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}welcome on\` or \`${ctx.prefix}welcome off\``;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
      }
      vipStore.updateGroupConfig(ctx.chatId, { welcome: arg === 'on' });
      const msg = `Group Welcome messages turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'goodbye',
    category: 'group',
    description: 'Member leave goodbye message on/off kare',
    usage: 'goodbye on/off',
    groupOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        const current = vipStore.getGroupConfig(ctx.chatId).goodbye;
        const msg = `Goodbye messages are currently *${current ? 'ON' : 'OFF'}*.\nUsage: \`${ctx.prefix}goodbye on\` or \`${ctx.prefix}goodbye off\``;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
      }
      vipStore.updateGroupConfig(ctx.chatId, { goodbye: arg === 'on' });
      const msg = `Group Goodbye messages turned *${arg.toUpperCase()}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'group',
    aliases: ['gc'],
    category: 'group',
    description: 'Group chat open ya sirf admins-only close kare',
    usage: 'group open/close',
    groupOnly: true,
    execute: async (ctx) => {
      const arg = ctx.args[0]?.toLowerCase();
      if (arg !== 'open' && arg !== 'close') {
        const msg = `Usage: \`${ctx.prefix}group open\` or \`${ctx.prefix}group close\``;
        await ctx.reply(msg);
        return msg;
      }
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      await ctx.sock!.groupSettingUpdate(
        ctx.chatId,
        arg === 'close' ? 'announcement' : 'not_announcement'
      );
      const msg =
        arg === 'close'
          ? 'Group closed: Only admins can send messages now.'
          : 'Group opened: All members can send messages now.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'mute',
    aliases: ['closegc'],
    category: 'group',
    description: 'Group ko sirf admins ke liye mute/close kare',
    usage: 'mute',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      await ctx.sock!.groupSettingUpdate(ctx.chatId, 'announcement');
      const msg = 'Group muted: Only admins can send messages now.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'unmute',
    aliases: ['opengc'],
    category: 'group',
    description: 'Group ko sab members ke liye open/unmute kare',
    usage: 'unmute',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      await ctx.sock!.groupSettingUpdate(ctx.chatId, 'not_announcement');
      const msg = 'Group unmuted: All members can send messages now.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'link',
    aliases: ['gclink', 'invitelink'],
    category: 'group',
    description: 'Group ka invite link generate kare',
    usage: 'link',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const code = await ctx.sock!.groupInviteCode(ctx.chatId);
      const msg = `*Group Invite Link:*\nhttps://chat.whatsapp.com/${code}`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'revoke',
    aliases: ['resetlink'],
    category: 'group',
    description: 'Purana group invite link reset kare',
    usage: 'revoke',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const code = await ctx.sock!.groupRevokeInvite(ctx.chatId);
      const msg = `*Group Invite Link Reset!*\nNew Link: https://chat.whatsapp.com/${code}`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'setname',
    aliases: ['setgcname'],
    category: 'group',
    description: 'Group ka subject/name change kare',
    usage: 'setname <new name>',
    groupOnly: true,
    execute: async (ctx) => {
      if (!ctx.text) {
        const msg = `Usage: \`${ctx.prefix}setname New Group Name\``;
        await ctx.reply(msg);
        return msg;
      }
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      await ctx.sock!.groupUpdateSubject(ctx.chatId, ctx.text);
      invalidateGroupMetadataCache(ctx.chatId);
      const msg = `Group name updated to *${ctx.text}*.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'setdesc',
    aliases: ['setgcdesc'],
    category: 'group',
    description: 'Group ki description update kare',
    usage: 'setdesc <description>',
    groupOnly: true,
    execute: async (ctx) => {
      if (!ctx.text) {
        const msg = `Usage: \`${ctx.prefix}setdesc New group description\``;
        await ctx.reply(msg);
        return msg;
      }
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      await ctx.sock!.groupUpdateDescription(ctx.chatId, ctx.text);
      invalidateGroupMetadataCache(ctx.chatId);
      const msg = 'Group description updated successfully.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'left',
    aliases: ['leave'],
    category: 'group',
    description: 'Owner command: bot ko current group se leave karwaye',
    usage: 'left',
    groupOnly: true,
    ownerOnly: true,
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = 'Simulated leave executed.';
        await ctx.reply(msg);
        return msg;
      }
      await ctx.reply('Leaving group cleanly. Goodbye!');
      await ctx.sock.groupLeave(ctx.chatId);
      return 'Left group.';
    },
  },
  {
    name: 'warn',
    category: 'group',
    description: 'Group member ko warning de (3 warnings par auto-kick)',
    usage: 'warn @user [reason]',
    groupOnly: true,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        await ctx.reply(check.reason!);
        return check.reason!;
      }
      const rawTargets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targets = resolveGroupTargetJids(check.participants, rawTargets);
      if (targets.length === 0) {
        const msg = `Mention or reply to a member to warn.\nUsage: \`${ctx.prefix}warn @user [reason]\``;
        await ctx.reply(msg);
        return msg;
      }
      const targetJid = targets[0];
      const botJids = await getBotJids(ctx.sock!);
      if (botJids.includes(targetJid)) {
        const msg = 'Cannot warn the bot itself.';
        await ctx.reply(msg);
        return msg;
      }

      const key = jidUserPart(targetJid);
      const groupCfg = vipStore.getGroupConfig(ctx.chatId);
      const warnings = { ...(groupCfg.warnings || {}) };
      const count = (warnings[key] || 0) + 1;
      const reason = ctx.args.slice(ctx.args[0]?.startsWith('@') ? 1 : 0).join(' ').trim() || 'Rule violation';

      if (count >= 3) {
        delete warnings[key];
        vipStore.updateGroupConfig(ctx.chatId, { warnings });
        if (check.botIsAdmin) {
          await ctx.sock!.groupParticipantsUpdate(ctx.chatId, [targetJid], 'remove').catch(() => {});
          invalidateGroupMetadataCache(ctx.chatId);
          const msg = `@${key} reached *3/3 warnings* (${reason}) and was removed from the group.`;
          await ctx.sock!.sendMessage(ctx.chatId, { text: msg, mentions: [targetJid] });
          return msg;
        }
        const msg = `@${key} reached *3/3 warnings* (${reason}). Promote the bot to admin for automatic removal.`;
        await ctx.sock!.sendMessage(ctx.chatId, { text: msg, mentions: [targetJid] });
        return msg;
      }

      warnings[key] = count;
      vipStore.updateGroupConfig(ctx.chatId, { warnings });
      const msg = `Warning *${count}/3* issued to @${key}.\nReason: ${reason}`;
      await ctx.sock!.sendMessage(ctx.chatId, { text: msg, mentions: [targetJid] });
      return msg;
    },
  },
  {
    name: 'tagadmin',
    aliases: ['admins', 'adminlist'],
    category: 'group',
    description: 'Group ke sab admins ko ek sath tag/mention kare',
    usage: 'tagadmin [message]',
    groupOnly: true,
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated TagAdmin] Pinged group admins.`;
        await ctx.reply(msg);
        return msg;
      }
      const meta = await getCachedGroupMetadata(ctx.sock, ctx.chatId);
      const adminJids = meta.participants.filter((p) => isParticipantAdmin(p)).map((p) => p.id);
      if (adminJids.length === 0) {
        const msg = 'No group admins found.';
        await ctx.reply(msg);
        return msg;
      }
      const header = ctx.text ? `*Admin Attention:* ${ctx.text}\n\n` : `*Group Admins (${adminJids.length})*\n\n`;
      const list = adminJids.map((j, i) => `${i + 1}. @${jidUserPart(j)}`).join('\n');
      await ctx.sock.sendMessage(ctx.chatId, { text: header + list, mentions: adminJids });
      return `Tagged ${adminJids.length} admins.`;
    },
  },
  {
    name: 'groupinfo',
    aliases: ['gcinfo', 'ginfo'],
    category: 'group',
    description: 'Group ki complete details aur moderation status show kare',
    usage: 'groupinfo',
    groupOnly: true,
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const cfg = vipStore.getGroupConfig(ctx.chatId);
        const msg = `*Group Info (${ctx.chatId})*\n• Antilink: ${cfg.antilinkMode || 'off'}\n• Welcome: ${cfg.welcome ? 'ON' : 'OFF'}`;
        await ctx.reply(msg);
        return msg;
      }
      const meta = await getCachedGroupMetadata(ctx.sock, ctx.chatId);
      const admins = meta.participants.filter((p) => isParticipantAdmin(p));
      const cfg = vipStore.getGroupConfig(ctx.chatId);
      const antilinkLabel = !cfg.antilink ? 'OFF' : (cfg.antilinkMode || 'delete').toUpperCase();
      const msg = [
        `*${meta.subject || 'Group Info'}*`,
        `• JID: \`${meta.id}\``,
        `• Members: ${meta.participants.length} (${admins.length} Admins)`,
        `• Antilink: ${antilinkLabel}`,
        `• Anti-Admin: ${cfg.antiAdmin ? 'ON' : 'OFF'} | Anti-KickAll: ${cfg.antiKickAll ? 'ON' : 'OFF'}`,
        `• Anti-Scam: ${cfg.antiScam ? 'ON' : 'OFF'} | Anti-Add: ${cfg.antiAdd ? 'ON' : 'OFF'}`,
        `• Anti-Forward: ${cfg.antiForward ? 'ON' : 'OFF'} | Anti-Media: ${cfg.antiMedia ? 'ON' : 'OFF'}`,
        `• Anti-Sticker: ${cfg.antiSticker ? 'ON' : 'OFF'} | Anti-Bot: ${cfg.antiBot ? 'ON' : 'OFF'}`,
        `• Anti-PayMsg: ${cfg.antiPayMsg ? 'ON' : 'OFF'} | Anti-Mention Status: ${cfg.antiStatusMention ? 'ON' : 'OFF'}`,
        `• Antidelete: ${cfg.antidelete ? 'ON' : 'OFF'}`,
        `• Welcome: ${cfg.welcome ? 'ON' : 'OFF'} | Welcome Card: ${cfg.welcomeImg ? 'ON' : 'OFF'} | Goodbye: ${cfg.goodbye ? 'ON' : 'OFF'}`,
        ...(meta.desc ? ['', `*Description:*\n${meta.desc.slice(0, 300)}`] : []),
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'setpp',
    aliases: ['setdp', 'setgcicon'],
    category: 'group',
    description: 'Replied image ko Group Icon (group mein) ya Bot DP (DM mein) lagaye',
    usage: 'setpp (reply to image)',
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to an image with `.setpp` to update the Group Icon or Bot Profile Photo.';
        await ctx.reply(msg);
        return msg;
      }
      const quoted = extractQuotedMessage(ctx.msg);
      const direct = unwrapMessage(ctx.msg.message);
      const holder =
        quoted && detectMediaType(quoted) === 'image'
          ? quoted
          : direct && detectMediaType(direct) === 'image'
            ? direct
            : null;
      if (!holder || !hasValidMediaPayload(holder)) {
        const msg = `Reply to a valid image with \`${ctx.prefix}setpp\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (ctx.isGroup) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
        if (!check.ok) {
          await ctx.reply(check.reason!);
          return check.reason!;
        }
        const buf = await downloadMessageMedia(ctx.sock, { key: ctx.msg.key, message: holder } as WAMessage);
        await ctx.sock.updateProfilePicture(ctx.chatId, buf);
        const msg = 'Group icon updated successfully.';
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.isOwner) {
        const msg = 'Only Bot Owner can update the bot profile photo.';
        await ctx.reply(msg);
        return msg;
      }
      const buf = await downloadMessageMedia(ctx.sock, { key: ctx.msg.key, message: holder } as WAMessage);
      const meJid = ctx.sock.user?.id || `${loadConfig().ownerNumber}@s.whatsapp.net`;
      await ctx.sock.updateProfilePicture(meJid, buf);
      const msg = 'Bot profile photo updated successfully.';
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'poll',
    aliases: ['fakepoll', 'fakevote', 'vote'],
    category: 'group',
    description: 'Real WhatsApp Poll ya custom vote counts ke sath Fake Poll banaye',
    usage: 'poll Question? | Opt1:95 | Opt2:12 (or Question? | Opt1 | Opt2)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const raw = ctx.text.trim();
      if (!raw || !raw.includes('|')) {
        const msg = [
          `*Poll & Fake Voting Usage:*`,
          `• Native Poll: \`${ctx.prefix}poll Best Bot? | FADI KING MD | Other\``,
          `• Custom/Fake Votes: \`${ctx.prefix}fakepoll Best Bot? | FADI KING:98 | Other:4\``,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      const parts = raw
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean);
      const question = parts[0];
      const optionTokens = parts.slice(1, 13);

      if (!question || optionTokens.length < 2) {
        const msg = 'Provide a question and at least 2 options separated by `|`.';
        await ctx.reply(msg);
        return msg;
      }

      // Check if user provided configured vote counts (e.g. `Option A:120` or `Option A=120`) or ran fakepoll
      const parsedOptions = optionTokens.map((tok) => {
        const match = tok.match(/^(.*?)\s*[:=]\s*(\d+)\s*$/);
        if (match) {
          return { label: match[1].trim() || tok, votes: Math.max(0, Number(match[2])), explicit: true };
        }
        return { label: tok, votes: 0, explicit: false };
      });

      const hasExplicitCounts = parsedOptions.some((o) => o.explicit) || ctx.commandName === 'fakepoll' || ctx.commandName === 'fakevote';

      if (hasExplicitCounts) {
        // Assign sensible default votes if someone ran `.fakepoll Q | A | B` without numbers
        const finalOptions = parsedOptions.map((o, idx) => ({
          label: o.label,
          votes: o.explicit ? o.votes : idx === 0 ? 85 : Math.max(2, 20 - idx * 5),
        }));
        const totalVotes = Math.max(
          1,
          finalOptions.reduce((sum, o) => sum + o.votes, 0)
        );
        const lines = [
          `📊 *POLL RESULTS*`,
          `*${question}*`,
          '',
          ...finalOptions.map((opt, idx) => {
            const pct = Math.round((opt.votes / totalVotes) * 100);
            const filled = Math.max(1, Math.round(pct / 10));
            const bar = '█'.repeat(Math.min(10, filled)) + '░'.repeat(Math.max(0, 10 - filled));
            return `${idx + 1}. *${opt.label}*\n   ${bar} *${pct}%* (${opt.votes} votes)`;
          }),
          '',
          `Total Votes: *${totalVotes}*`,
        ];
        const card = lines.join('\n');
        await ctx.reply(card);
        return card;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated Poll] *${question}*\n${parsedOptions.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`;
        await ctx.reply(msg);
        return msg;
      }

      await ctx.sock.sendMessage(ctx.chatId, {
        poll: {
          name: question,
          values: parsedOptions.map((o) => o.label),
          selectableCount: 1,
        },
      });
      return `Poll created: ${question}`;
    },
  },
  {
    name: 'groupdp',
    aliases: ['gdp', 'gcpp', 'groupicon'],
    category: 'group',
    description: 'Group ki high-resolution profile picture (DP) nikal kar chat mein bheje',
    usage: 'groupdp',
    groupOnly: true,
    cooldownSeconds: 4,
    execute: async (ctx) => {
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated] Group DP fetch ready for ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }

      const cfg = loadConfig();
      let groupSubject = 'WhatsApp Group';
      try {
        const meta = await getCachedGroupMetadata(ctx.sock, ctx.chatId);
        if (meta?.subject) groupSubject = meta.subject;
      } catch {
        // Optional metadata
      }

      let dpUrl: string | undefined;
      try {
        dpUrl = await ctx.sock.profilePictureUrl(ctx.chatId, 'image');
      } catch {
        try {
          dpUrl = await ctx.sock.profilePictureUrl(ctx.chatId, 'preview');
        } catch {
          dpUrl = undefined;
        }
      }

      if (!dpUrl) {
        const msg = 'No profile picture found for this group (or group DP is hidden/removed).';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const res = await fetch(dpUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            image: buffer,
            caption: `🖼️ *Group Profile Picture*\n• Group: *${groupSubject}*\n• Saved by *${cfg.botName || 'FADI KING MD'}*`,
          },
          { quoted: ctx.msg ?? undefined }
        );
        return `Sent group DP for ${groupSubject}.`;
      } catch (err) {
        const msg = `Failed to download group DP: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'approve',
    aliases: ['acceptall'],
    category: 'group',
    description: 'Current group ke tamam pending join requests ek sath approve kare',
    usage: 'approve',
    groupOnly: true,
    cooldownSeconds: 4,
    execute: async (ctx) => bulkHandlePendingRequests(ctx, 'approve'),
  },
  {
    name: 'approveall',
    aliases: ['acceptpending'],
    category: 'group',
    description: 'Group ke tamam pending join requests bulk mein approve kare',
    usage: 'approveall',
    groupOnly: true,
    cooldownSeconds: 4,
    execute: async (ctx) => bulkHandlePendingRequests(ctx, 'approve'),
  },
  {
    name: 'rejectall',
    aliases: ['denyall', 'declineall'],
    category: 'group',
    description: 'Group ke tamam pending join requests bulk mein reject kare',
    usage: 'rejectall',
    groupOnly: true,
    cooldownSeconds: 4,
    execute: async (ctx) => bulkHandlePendingRequests(ctx, 'reject'),
  },
  {
    name: 'kickall',
    aliases: ['removeall', 'cleanmembers'],
    category: 'group',
    description: 'Group se tamam non-admin members ko safe rate-limit delay ke sath remove kare',
    usage: 'kickall',
    groupOnly: true,
    cooldownSeconds: 10,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        const errText = check.reason || 'Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated] Paced kickall started for non-admin members in ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }

      const cfg = loadConfig();
      const ownerClean = normalizePhone(cfg.ownerNumber);
      const botJids = await getBotJids(ctx.sock);
      const botSet = new Set(botJids.map((j) => jidUserPart(j)));

      const nonAdmins = check.participants.filter((p) => {
        if (isParticipantAdmin(p)) return false;
        const userPart = jidUserPart(p.id);
        const pnPart = jidUserPart(p.phoneNumber || p.id);
        if (botSet.has(userPart) || botSet.has(pnPart)) return false;
        if (ownerClean && (normalizePhone(userPart) === ownerClean || normalizePhone(pnPart) === ownerClean)) {
          return false;
        }
        return true;
      });

      if (nonAdmins.length === 0) {
        const msg = 'No non-admin members to remove from this group.';
        await ctx.reply(msg);
        return msg;
      }

      await ctx.reply(
        `Removing *${nonAdmins.length}* non-admin member(s) safely with anti-ban delay...`
      );

      let removed = 0;
      for (let i = 0; i < nonAdmins.length; i += 1) {
        const target = nonAdmins[i];
        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatId, [target.id], 'remove');
          removed += 1;
        } catch (err) {
          logger.warn('kickall', `Skipped ${target.id} in ${ctx.chatId}: ${(err as Error).message}`);
        }
        if (i < nonAdmins.length - 1) {
          await new Promise((r) => setTimeout(r, 1350));
        }
      }

      invalidateGroupMetadataCache(ctx.chatId);
      const doneMsg = `✅ Kickall finished: removed *${removed}/${nonAdmins.length}* non-admin member(s).`;
      await ctx.reply(doneMsg);
      return doneMsg;
    },
  },
  {
    name: 'pin',
    aliases: ['pinmsg'],
    category: 'group',
    description: 'Replied message ko group chat mein pin kare (24h, 7d, ya 30d)',
    usage: 'pin [24h|7d|30d] (reply to a message)',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        const errText = check.reason || 'Group Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = `[Simulated] Pinned replied message in ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }

      const ctxInfo = extractContextInfo(ctx.msg.message);
      if (!ctxInfo?.stanzaId) {
        const msg = `Reply to the message you want to pin using \`${ctx.prefix}pin\` (optional: \`24h\`, \`7d\`, \`30d\`).`;
        await ctx.reply(msg);
        return msg;
      }

      const durArg = ctx.args[0]?.toLowerCase();
      const durationSec: 86400 | 604800 | 2592000 =
        durArg === '24h' || durArg === '1d'
          ? 86400
          : durArg === '30d' || durArg === '1m'
            ? 2592000
            : 604800;

      const botJids = await getBotJids(ctx.sock);
      const participant = ctxInfo.participant || undefined;
      const isFromBot = Boolean(
        participant && botJids.some((b) => jidUserPart(b) === jidUserPart(participant))
      );

      await ctx.sock.sendMessage(ctx.chatId, {
        pin: {
          remoteJid: ctx.chatId,
          id: ctxInfo.stanzaId,
          fromMe: isFromBot,
          participant,
        },
        type: proto.PinInChat.Type.PIN_FOR_ALL,
        time: durationSec,
      });

      const label = durationSec === 86400 ? '24 hours' : durationSec === 2592000 ? '30 days' : '7 days';
      return `Pinned message for ${label}.`;
    },
  },
  {
    name: 'unpin',
    aliases: ['unpinmsg'],
    category: 'group',
    description: 'Replied message ko group chat se unpin kare',
    usage: 'unpin (reply to pinned message)',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        const errText = check.reason || 'Group Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = `[Simulated] Unpinned replied message in ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }

      const ctxInfo = extractContextInfo(ctx.msg.message);
      if (!ctxInfo?.stanzaId) {
        const msg = `Reply to the pinned message you want to unpin using \`${ctx.prefix}unpin\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const botJids = await getBotJids(ctx.sock);
      const participant = ctxInfo.participant || undefined;
      const isFromBot = Boolean(
        participant && botJids.some((b) => jidUserPart(b) === jidUserPart(participant))
      );

      await ctx.sock.sendMessage(ctx.chatId, {
        pin: {
          remoteJid: ctx.chatId,
          id: ctxInfo.stanzaId,
          fromMe: isFromBot,
          participant,
        },
        type: proto.PinInChat.Type.UNPIN_FOR_ALL,
      });

      return 'Message unpinned.';
    },
  },
  {
    name: 'antiadd',
    aliases: ['noAdd'],
    category: 'group',
    description: 'Non-admin ke member add karne par naye user ko auto-remove aur warn kare',
    usage: 'antiadd <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiAdd',
        'Anti-Add Guard',
        'Unauthorized member additions by non-admins will be automatically removed.'
      ),
  },
  {
    name: 'antiforward',
    aliases: ['noforward'],
    category: 'group',
    description: 'Non-admins ke forwarded ya frequently forwarded messages auto-delete kare',
    usage: 'antiforward <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiForward',
        'Anti-Forward Guard',
        'Forwarded messages from non-admins will be automatically deleted.'
      ),
  },
  {
    name: 'antimedia',
    aliases: ['nomedia'],
    category: 'group',
    description: 'Non-admins ki photos, videos, voice/audio aur documents auto-delete kare',
    usage: 'antimedia <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiMedia',
        'Anti-Media Guard',
        'Images, videos, audio/voice notes, and documents from non-admins will be deleted.'
      ),
  },
  {
    name: 'antisticker',
    aliases: ['nosticker'],
    category: 'group',
    description: 'Non-admins ke stickers ko is group mein automatic delete kare',
    usage: 'antisticker <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiSticker',
        'Anti-Sticker Guard',
        'Stickers from non-admins will be automatically deleted.'
      ),
  },
  {
    name: 'antibot',
    aliases: ['nobot'],
    category: 'group',
    description: 'Unauthorized bot accounts aur automated joiners ko detect kar ke kick kare',
    usage: 'antibot <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiBot',
        'Anti-Bot Shield',
        'Automated bot accounts and unauthorized bots will be kicked when bot is admin.'
      ),
  },
  {
    name: 'antipaymsg',
    aliases: ['antipay', 'antipaylock', 'nopaymsg'],
    category: 'group',
    description: 'Group mein non-admins ke payment request, pay message, order aur invoice auto-delete kare',
    usage: 'antipaymsg <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiPayMsg',
        'Anti-PayMsg Guard',
        'Payment requests, payment cards, orders, and invoice messages from non-admins will be automatically deleted.'
      ),
  },
  {
    name: 'muteuser',
    aliases: ['silence', 'timeout'],
    category: 'group',
    description: 'Target member ko muqarrar waqt ke liye mute kare (messages auto-delete honge)',
    usage: 'muteuser <@user|reply> <duration> (e.g. 10m, 1h)',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
      if (!check.ok) {
        const errText = check.reason || 'Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }

      const durToken = ctx.args.find(
        (a) => !a.startsWith('@') && !/^\+?\d{7,15}$/.test(a) && parseDurationMs(a) !== null
      );
      const durationMs = durToken ? parseDurationMs(durToken) : null;
      if (!durationMs) {
        const msg = `Usage: \`${ctx.prefix}muteuser @user 10m\` (or reply to their message with \`${ctx.prefix}muteuser 10m\`).`;
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated] Muted user for ${formatDurationHuman(durationMs)} in ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }

      const targetArgs = ctx.args.filter((a) => !parseDurationMs(a));
      const rawTargets = extractRawTargetCandidates(ctx.msg, targetArgs);
      const targets = resolveGroupTargetJids(check.participants, rawTargets);
      if (targets.length === 0) {
        const msg = `Mention \`@user\` or reply to their message: \`${ctx.prefix}muteuser @user ${durToken}\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const targetJid = targets[0];
      const targetParticipant = findParticipant(check.participants, [targetJid]);
      const cfg = loadConfig();
      const ownerClean = normalizePhone(cfg.ownerNumber);
      const botJids = await getBotJids(ctx.sock);
      const targetKeys = Array.from(
        new Set(
          [
            jidUserPart(targetJid),
            jidUserPart(targetParticipant?.id),
            jidUserPart(targetParticipant?.phoneNumber),
          ].filter(Boolean)
        )
      );

      if (botJids.some((b) => targetKeys.includes(jidUserPart(b)))) {
        const msg = 'Cannot mute the bot itself.';
        await ctx.reply(msg);
        return msg;
      }
      if (ownerClean && targetKeys.some((k) => normalizePhone(k) === ownerClean)) {
        const msg = 'Cannot mute the Bot Owner.';
        await ctx.reply(msg);
        return msg;
      }
      if (isParticipantAdmin(targetParticipant)) {
        const msg = 'Cannot mute a Group Admin. Demote them first if needed.';
        await ctx.reply(msg);
        return msg;
      }

      const groupCfg = vipStore.getGroupConfig(ctx.chatId);
      const nextMuted = { ...(groupCfg.mutedUsers || {}) };
      const expiresAt = Date.now() + durationMs;
      for (const k of targetKeys) {
        nextMuted[k] = { expiresAt, reason: `Muted by +${ctx.senderNumber}` };
      }
      vipStore.updateGroupConfig(ctx.chatId, { mutedUsers: nextMuted });

      const display = jidUserPart(targetParticipant?.phoneNumber || targetJid);
      await ctx.sock.sendMessage(ctx.chatId, {
        text: `🔇 *@${display}* has been muted for *${formatDurationHuman(durationMs)}*.\n_Their messages in this group will be automatically deleted._`,
        mentions: [targetJid],
      });
      return `Muted +${display} for ${formatDurationHuman(durationMs)}.`;
    },
  },
  {
    name: 'unmuteuser',
    aliases: ['unsilence', 'untimeout'],
    category: 'group',
    description: 'Muted member ko foran unmute kare aur mute record hataye',
    usage: 'unmuteuser <@user|reply>',
    groupOnly: true,
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        const errText = check.reason || 'Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated] Unmuted user in ${ctx.chatId}.`;
        await ctx.reply(msg);
        return msg;
      }

      const rawTargets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targets = resolveGroupTargetJids(check.participants, rawTargets);
      if (targets.length === 0) {
        const msg = `Mention \`@user\` or reply to their message with \`${ctx.prefix}unmuteuser\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const targetJid = targets[0];
      const targetParticipant = findParticipant(check.participants, [targetJid]);
      const keysToClear = Array.from(
        new Set(
          [
            jidUserPart(targetJid),
            jidUserPart(targetParticipant?.id),
            jidUserPart(targetParticipant?.phoneNumber),
          ].filter(Boolean)
        )
      );

      const groupCfg = vipStore.getGroupConfig(ctx.chatId);
      const nextMuted = { ...(groupCfg.mutedUsers || {}) };
      let removedAny = false;
      for (const k of keysToClear) {
        if (nextMuted[k]) {
          delete nextMuted[k];
          removedAny = true;
        }
      }
      vipStore.updateGroupConfig(ctx.chatId, { mutedUsers: nextMuted });

      const display = jidUserPart(targetParticipant?.phoneNumber || targetJid);
      const replyText = removedAny
        ? `🔊 *@${display}* has been unmuted and can chat again.`
        : `🔊 *@${display}* was not actively muted (record ensured clear).`;
      await ctx.sock.sendMessage(ctx.chatId, {
        text: replyText,
        mentions: [targetJid],
      });
      return `Unmuted +${display}.`;
    },
  },
  {
    name: 'clearwarn',
    aliases: ['resetwarn', 'delwarn'],
    category: 'group',
    description: 'Group mein target member ki antilink aur anti-scam warnings reset kare',
    usage: 'clearwarn <@user|reply>',
    groupOnly: true,
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        const errText = check.reason || 'Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }

      const rawTargets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targets =
        ctx.sock && !ctx.isSimulated
          ? resolveGroupTargetJids(check.participants, rawTargets)
          : rawTargets.map((t) => normalizeBareJid(t)).filter(Boolean);

      if (targets.length === 0) {
        const msg = `Mention \`@user\`, pass a phone number, or reply to a message with \`${ctx.prefix}clearwarn\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const targetJid = targets[0];
      const targetParticipant = findParticipant(check.participants, [targetJid]);
      const candidateParts = new Set(
        [
          targetJid,
          jidUserPart(targetJid),
          targetParticipant?.id,
          jidUserPart(targetParticipant?.id),
          targetParticipant?.phoneNumber,
          jidUserPart(targetParticipant?.phoneNumber),
        ]
          .filter(Boolean)
          .map((s) => String(s))
      );

      const groupCfg = vipStore.getGroupConfig(ctx.chatId);
      const warnings = { ...(groupCfg.warnings || {}) };
      const antiScamWarnings = { ...(groupCfg.antiScamWarnings || {}) };
      let clearedCount = 0;

      for (const map of [warnings, antiScamWarnings]) {
        for (const key of Object.keys(map)) {
          if (candidateParts.has(key) || candidateParts.has(jidUserPart(key))) {
            clearedCount += Number(map[key] || 0);
            delete map[key];
          }
        }
      }

      vipStore.updateGroupConfig(ctx.chatId, { warnings, antiScamWarnings });
      const display = jidUserPart(targetParticipant?.phoneNumber || targetJid);
      const text = `🧽 Cleared warnings (*${clearedCount}* total) for *@${display}* in this group.`;

      if (ctx.sock && !ctx.isSimulated) {
        await ctx.sock.sendMessage(ctx.chatId, { text, mentions: [targetJid] });
      } else {
        await ctx.reply(text);
      }
      return text;
    },
  },
  {
    name: 'slowmode',
    aliases: ['slow'],
    category: 'group',
    description: 'Group mein non-admins ke liye message cooldown interval set ya band kare',
    usage: 'slowmode <seconds|off> (e.g. 10, 30, off)',
    groupOnly: true,
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
      if (!check.ok) {
        const errText = check.reason || 'Admin privileges required.';
        await ctx.reply(errText);
        return errText;
      }

      const arg = ctx.args[0]?.toLowerCase() || '';
      const groupCfg = vipStore.getGroupConfig(ctx.chatId);
      if (!arg) {
        const cur = Number(groupCfg.slowModeSeconds || 0);
        const msg = `🐢 Group Slow Mode is currently *${cur > 0 ? `${cur}s` : 'OFF'}*.\nUsage: \`${ctx.prefix}slowmode 10\` or \`${ctx.prefix}slowmode off\``;
        await ctx.reply(msg);
        return msg;
      }

      if (arg === 'off' || arg === '0') {
        vipStore.updateGroupConfig(ctx.chatId, { slowModeSeconds: 0 });
        const msg = '🐢 *Slow Mode turned OFF* for this group.';
        await ctx.reply(msg);
        return msg;
      }

      let seconds = /^\d+$/.test(arg) ? Number(arg) : NaN;
      if (!Number.isFinite(seconds)) {
        const parsedMs = parseDurationMs(arg);
        if (parsedMs) seconds = Math.round(parsedMs / 1000);
      }

      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
        const msg = `Provide a valid cooldown between \`1\` and \`3600\` seconds, or \`off\`. Example: \`${ctx.prefix}slowmode 15\``;
        await ctx.reply(msg);
        return msg;
      }

      const cleanSec = Math.round(seconds);
      vipStore.updateGroupConfig(ctx.chatId, { slowModeSeconds: cleanSec });
      const msg = `🐢 *Slow Mode set to ${cleanSec}s* — non-admins sending faster than once per ${cleanSec}s will have excess messages removed.`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'giveaway',
    aliases: ['raffle', 'pickwinner'],
    category: 'group',
    description: 'Group members mein se random winner(s) select kare',
    usage: 'giveaway [winner_count]',
    groupOnly: true,
    cooldownSeconds: 5,
    execute: async (ctx) => {
      const requestedCount = ctx.args[0] ? Number(ctx.args[0]) : 1;
      const winnerCount =
        Number.isFinite(requestedCount) && requestedCount >= 1
          ? Math.min(10, Math.floor(requestedCount))
          : 1;

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `🎁 *Giveaway Winner(s) (${winnerCount})*\n1. +${ctx.senderNumber} (Simulated Sample)`;
        await ctx.reply(msg);
        return msg;
      }

      const meta = await getCachedGroupMetadata(ctx.sock, ctx.chatId, true);
      const botJids = await getBotJids(ctx.sock);
      const botSet = new Set(botJids.map((j) => jidUserPart(j)));

      const pool = meta.participants.filter((p) => {
        const u1 = jidUserPart(p.id);
        const u2 = jidUserPart(p.phoneNumber || p.id);
        return !botSet.has(u1) && !botSet.has(u2);
      });

      if (pool.length === 0) {
        const msg = 'No eligible group participants found for giveaway.';
        await ctx.reply(msg);
        return msg;
      }

      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const chosen = shuffled.slice(0, Math.min(winnerCount, shuffled.length));
      const mentions = chosen.map((p) => p.id);
      const winnerLines = chosen.map(
        (p, idx) => `${idx + 1}. 🏆 @${jidUserPart(p.phoneNumber || p.id)}`
      );

      const text = [
        `🎁 *GROUP GIVEAWAY RESULTS*`,
        `• Group: *${meta.subject || 'WhatsApp Group'}*`,
        `• Eligible Members: ${pool.length}`,
        '',
        ...winnerLines,
      ].join('\n');

      await ctx.sock.sendMessage(ctx.chatId, { text, mentions }, { quoted: ctx.msg ?? undefined });
      return `Selected ${chosen.length} giveaway winner(s).`;
    },
  },
  {
    name: 'pollcreate',
    aliases: ['newpoll', 'createpoll'],
    category: 'group',
    description: 'Group mein multi-option WhatsApp poll create kare (Question | Opt1 | Opt2)',
    usage: 'pollcreate Question? | Option 1 | Option 2 | Option 3',
    cooldownSeconds: 4,
    execute: async (ctx) => {
      const segments = ctx.text
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);

      if (segments.length < 3) {
        const msg = `Provide a question and at least 2 options separated by \`|\`.\nExample: \`${ctx.prefix}pollcreate Best time for meeting? | 6 PM | 8 PM | 10 PM\``;
        await ctx.reply(msg);
        return msg;
      }

      const question = segments[0].slice(0, 255);
      const uniqueOptions = Array.from(new Set(segments.slice(1))).slice(0, 12);
      if (uniqueOptions.length < 2) {
        const msg = 'A poll requires at least 2 distinct options.';
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `🗳️ *[Simulated Poll]* ${question}\n${uniqueOptions.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
        await ctx.reply(msg);
        return msg;
      }

      await ctx.sock.sendMessage(
        ctx.chatId,
        {
          poll: {
            name: question,
            values: uniqueOptions,
            selectableCount: 1,
          },
        },
        { quoted: ctx.msg ?? undefined }
      );
      return `Created poll "${question}" with ${uniqueOptions.length} options.`;
    },
  },
  {
    name: 'welcomeimg',
    aliases: ['welcomeimage', 'wimg', 'imgwelcome', 'welcomecard'],
    category: 'group',
    description: 'New member join hone par profile photo aur group naam ke sath stylized Welcome Image Card on/off kare',
    usage: 'welcomeimg <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'welcomeImg',
        'Welcome Image Card',
        'New members will receive a stylized welcome image card with their name, number, and profile photo.',
        { requireBotAdminWhenOn: false }
      ),
  },
  {
    name: 'antiadmin',
    aliases: ['nopromote', 'antipromote'],
    category: 'group',
    description: 'Group Creator ya Bot Owner ke ilawa kisi bhi unauthorized admin promotion ko auto-demote kare',
    usage: 'antiadmin <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiAdmin',
        'Anti-Admin Guard',
        'Only the Group Creator or Bot Owner can promote admins; unauthorized promotions will be automatically demoted.',
        { requireBotAdminWhenOn: true }
      ),
  },
  {
    name: 'antikickall',
    aliases: ['nokickall', 'antimasskick'],
    category: 'group',
    description: 'Rapid/bulk member removals (kickall attempt) karne wale admin ko turant demote kare (bina members re-add kiye)',
    usage: 'antikickall <on|off>',
    groupOnly: true,
    cooldownSeconds: 3,
    execute: async (ctx) =>
      togglePerGroupProtection(
        ctx,
        'antiKickAll',
        'Anti-KickAll Shield',
        'Any admin (except Group Creator/Bot Owner) performing rapid or bulk kicks will be immediately demoted.',
        { requireBotAdminWhenOn: true }
      ),
  },
  {
    name: 'resetgroup',
    aliases: ['groupreset', 'resetgc', 'gcreset'],
    category: 'group',
    description: 'Current group ke tamam bot toggles aur settings default state par reset kare',
    usage: 'resetgroup',
    groupOnly: true,
    cooldownSeconds: 4,
    execute: async (ctx) => {
      if (!ctx.isSimulated) {
        const check = await verifyGroupAdmins(ctx, { requireBotAdmin: false });
        if (!check.ok) {
          const errText = check.reason || 'Only Group Admins or Bot Owner can reset group settings.';
          await ctx.reply(errText);
          return errText;
        }
      } else if (!ctx.isOwner) {
        const errText = 'Only Group Admins or Bot Owner can reset group settings.';
        await ctx.reply(errText);
        return errText;
      }

      const reset = vipStore.resetGroupConfig(ctx.chatId);
      const msg = [
        `🔄 *Group Settings Reset to Default*`,
        `• Group: \`${ctx.chatId}\``,
        `• AI Chat: *OFF* | Welcome / Card / Goodbye: *OFF*`,
        `• Antilink / Antidelete / Slow Mode: *OFF*`,
        `• Anti-Add / Anti-Forward / Anti-Media / Anti-Sticker: *OFF*`,
        `• Anti-Bot / Anti-PayMsg / Anti-Admin / Anti-KickAll: *OFF*`,
        `• Anti-Scam: *${reset.antiScam ? 'ON (Global Default)' : 'OFF'}* | Anti-Mention: *${reset.antiStatusMention ? 'ON (Global Default)' : 'OFF'}*`,
        `• Warnings & Mutes: *Cleared*`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
];

async function bulkHandlePendingRequests(
  ctx: CommandContext,
  action: 'approve' | 'reject'
): Promise<string> {
  const check = await verifyGroupAdmins(ctx, { requireBotAdmin: true });
  if (!check.ok) {
    const errText = check.reason || 'Admin privileges required.';
    await ctx.reply(errText);
    return errText;
  }
  const verbPast = action === 'approve' ? 'Approved' : 'Rejected';
  if (!ctx.sock || ctx.isSimulated) {
    const msg = `[Simulated] ${verbPast} all pending join requests in ${ctx.chatId}.`;
    await ctx.reply(msg);
    return msg;
  }

  try {
    const pending = await ctx.sock.groupRequestParticipantsList(ctx.chatId);
    const jids = pending
      .map((p) => (typeof p === 'string' ? p : p.jid))
      .filter((j): j is string => Boolean(j));

    if (jids.length === 0) {
      const msg = 'No pending join requests found in this group.';
      await ctx.reply(msg);
      return msg;
    }

    let handled = 0;
    const BATCH = 15;
    for (let i = 0; i < jids.length; i += BATCH) {
      const chunk = jids.slice(i, i + BATCH);
      await ctx.sock.groupRequestParticipantsUpdate(ctx.chatId, chunk, action);
      handled += chunk.length;
      if (i + BATCH < jids.length) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    invalidateGroupMetadataCache(ctx.chatId);
    const emoji = action === 'approve' ? '✅' : '❌';
    const msg = `${emoji} ${verbPast} *${handled}* pending join request(s) in this group.`;
    await ctx.reply(msg);
    return msg;
  } catch (err) {
    const msg = `Failed to ${action} pending requests: ${(err as Error).message}`;
    await ctx.reply(msg);
    return msg;
  }
}

async function togglePerGroupProtection(
  ctx: CommandContext,
  field:
    | 'antiAdd'
    | 'antiForward'
    | 'antiMedia'
    | 'antiSticker'
    | 'antiBot'
    | 'antiPayMsg'
    | 'antiAdmin'
    | 'antiKickAll'
    | 'welcomeImg',
  label: string,
  activeSummary: string,
  options: { requireBotAdminWhenOn?: boolean } = {}
): Promise<string> {
  const arg = ctx.args[0]?.toLowerCase();
  const current = Boolean(vipStore.getGroupConfig(ctx.chatId)[field]);

  const check = ctx.isSimulated
    ? { ok: true, botIsAdmin: true, participants: [] as GroupParticipant[] }
    : await verifyGroupAdmins(ctx, {
        requireBotAdmin: Boolean(options.requireBotAdminWhenOn && arg === 'on'),
      });
  if (!check.ok) {
    const errText = check.reason || 'Group Admin privileges required.';
    await ctx.reply(errText);
    return errText;
  }

  if (arg !== 'on' && arg !== 'off') {
    const msg = `${label} is currently *${current ? 'ON' : 'OFF'}* in this group.\nUsage: \`${ctx.prefix}${ctx.commandName} on\` or \`${ctx.prefix}${ctx.commandName} off\``;
    await ctx.reply(msg);
    return msg;
  }

  const enabled = arg === 'on';
  vipStore.updateGroupConfig(ctx.chatId, { [field]: enabled });

  let adminHint = '';
  if (
    enabled &&
    !options.requireBotAdminWhenOn &&
    field !== 'welcomeImg' &&
    ctx.sock &&
    !ctx.isSimulated
  ) {
    const botJids = await getBotJids(ctx.sock);
    const botParticipant = findParticipant(check.participants, botJids);
    if (!isParticipantAdmin(botParticipant)) {
      adminHint = '\n_Note: Make the bot a Group Admin so it can automatically enforce this rule._';
    }
  }

  const icon = field === 'welcomeImg' ? '🖼️' : '🛡️';
  const msg = enabled
    ? `${icon} *${label} turned ON* for this group.\n${activeSummary}${adminHint}`
    : `⚪ *${label} turned OFF* for this group.`;
  await ctx.reply(msg);
  return msg;
}
