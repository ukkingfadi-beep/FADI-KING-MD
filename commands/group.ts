import {
  generateWAMessageContent,
  generateWAMessageFromContent,
  getUrlInfo,
  type AnyMessageContent,
  type GroupParticipant,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { isValidPhone, loadConfig, normalizePhone, saveConfig } from '../config/bot.config.ts';
import { normalizeFileSha256 } from '../handlers/group.ts';
import {
  extractFirstUrl,
  extractRawTargetCandidates,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  hasValidMediaPayload,
  invalidateGroupMetadataCache,
  isParticipantAdmin,
  jidUserPart,
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
      let autoRemoveSec = 15; // Auto-remove after 15s by default

      // Parse optional target group via `1 | text` or `120363...@g.us | text`
      if (rawBody.includes('|')) {
        const [left, ...rest] = rawBody.split('|');
        const targetSpec = left.trim();
        rawBody = rest.join('|').trim();

        if (/^\d{1,3}s$/i.test(targetSpec)) {
          autoRemoveSec = Math.max(3, Math.min(300, Number(targetSpec.slice(0, -1))));
        } else if (targetSpec.toLowerCase() === 'keep') {
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
        // From DM without `|`: e.g. `.gcstatus 1 Hello everyone` or `.gcstatus 120363xxx@g.us Hello`
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

      if (!targetGroupJid || !targetGroupJid.endsWith('@g.us')) {
        const msg = [
          `*GC Status Usage:*`,
          `• Inside a group: \`${ctx.prefix}gcstatus Your status text\``,
          `• To any group from anywhere: \`${ctx.prefix}gcstatus 1 | Your status text\` (see \`${ctx.prefix}gclist\`)`,
          `• With image/video/audio: reply to media with \`${ctx.prefix}gcstatus\``,
          `• Custom auto-remove: \`${ctx.prefix}gcstatus 10s Your text\` (default 15s auto-remove)`,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      // Parse optional leading duration token like `10s`, `10s | text`, or `keep`
      const firstToken = rawBody.split(/\s+/)[0]?.toLowerCase() || '';
      if (/^\d{1,3}s$/.test(firstToken)) {
        autoRemoveSec = Math.max(3, Math.min(300, Number(firstToken.slice(0, -1))));
        rawBody = rawBody.slice(firstToken.length).replace(/^\s*\|\s*/, '').trim();
      } else if (firstToken === 'keep') {
        autoRemoveSec = 0;
        rawBody = rawBody.slice(firstToken.length).replace(/^\s*\|\s*/, '').trim();
      }

      // Check permissions on target group
      const adminCheck = await verifyGroupAdmins(ctx, {
        requireBotAdmin: false,
        targetGroupId: targetGroupJid,
      });
      if (!adminCheck.ok) {
        await ctx.reply(adminCheck.reason!);
        return adminCheck.reason!;
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

      let sentKey: WAMessage['key'] | undefined;
      try {
        const innerContent = await generateWAMessageContent(anyContent, {
          upload: ctx.sock.waUploadToServer,
        });
        const built = generateWAMessageFromContent(
          targetGroupJid,
          { groupStatusMessageV2: { message: innerContent } },
          { userJid: ctx.sock.user?.id || `${loadConfig().ownerNumber}@s.whatsapp.net` }
        );
        await ctx.sock.relayMessage(targetGroupJid, built.message!, {
          messageId: built.key.id!,
        });
        sentKey = built.key;
      } catch {
        // Fallback if groupStatusMessageV2 isn't accepted in a specific group
        const sent = await ctx.sock.sendMessage(targetGroupJid, anyContent);
        sentKey = sent?.key;
      }

      if (autoRemoveSec > 0 && sentKey) {
        const sockRef = ctx.sock;
        const keyToDelete = sentKey;
        setTimeout(() => {
          void sockRef.sendMessage(targetGroupJid, { delete: keyToDelete }).catch(() => {});
        }, autoRemoveSec * 1000);
      }

      const meta = await getCachedGroupMetadata(ctx.sock, targetGroupJid).catch(() => null);
      const gcName = meta?.subject || targetGroupJid;
      const doneMsg =
        autoRemoveSec > 0
          ? `GC Status posted on *${gcName}*! It will auto-remove in *${autoRemoveSec}s*.`
          : `GC Status posted on *${gcName}* (kept in chat).`;
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
    name: 'bansticker',
    aliases: ['blocksticker', 'unbansticker'],
    category: 'group',
    description: 'Kisi ghatiya sticker par reply karke usay database mein ban/unban kare',
    usage: 'bansticker [list|unban]',
    execute: async (ctx) => {
      if (ctx.args[0]?.toLowerCase() === 'list') {
        const count = vipStore.listBannedStickers().length;
        const msg = `Total banned stickers in database: *${count}*`;
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
        const msg = 'Only Bot Owner or Group Admins can ban stickers.';
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.msg || ctx.isSimulated) {
        const msg = `Reply to any bad sticker with \`${ctx.prefix}bansticker\` to block it in all Anti-Scam groups.`;
        await ctx.reply(msg);
        return msg;
      }

      const quoted = extractQuotedMessage(ctx.msg);
      const sticker = quoted?.stickerMessage;
      if (!sticker) {
        const msg = `Reply to a sticker with \`${ctx.prefix}bansticker\` (or \`${ctx.prefix}unbansticker\` to remove).`;
        await ctx.reply(msg);
        return msg;
      }

      const sha = normalizeFileSha256(sticker.fileSha256);
      if (!sha) {
        const msg = 'Could not read sticker hash. Try replying to a freshly sent sticker.';
        await ctx.reply(msg);
        return msg;
      }

      if (ctx.commandName === 'unbansticker' || ctx.args[0]?.toLowerCase() === 'off' || ctx.args[0]?.toLowerCase() === 'unban') {
        const removed = vipStore.unbanSticker(sha);
        const msg = removed
          ? 'Sticker removed from the banned list.'
          : 'This sticker was not in the banned list.';
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

      const msg = 'Sticker banned in persistent database! Any member sending it in Anti-Scam groups will have it deleted.';
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
    name: 'resetwarn',
    aliases: ['clearwarn'],
    category: 'group',
    description: 'Member ki group warnings reset kare',
    usage: 'resetwarn @user',
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
        const msg = `Mention or reply to a member to reset warnings.`;
        await ctx.reply(msg);
        return msg;
      }
      const targetJid = targets[0];
      const key = jidUserPart(targetJid);
      const groupCfg = vipStore.getGroupConfig(ctx.chatId);
      const warnings = { ...(groupCfg.warnings || {}) };
      delete warnings[key];
      vipStore.updateGroupConfig(ctx.chatId, { warnings });
      const msg = `Cleared all warnings for @${key}.`;
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
        `• Anti-Scam: ${cfg.antiScam ? 'ON' : 'OFF'}`,
        `• Antidelete: ${cfg.antidelete ? 'ON' : 'OFF'}`,
        `• Welcome: ${cfg.welcome ? 'ON' : 'OFF'} | Goodbye: ${cfg.goodbye ? 'ON' : 'OFF'}`,
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
];
