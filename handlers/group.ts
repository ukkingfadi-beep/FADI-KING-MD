import type { BaileysEventMap, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { loadConfig } from '../config/bot.config.ts';
import {
  extractBodyText,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  invalidateGroupMetadataCache,
  isParticipantAdmin,
  jidUserPart,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import { vipStore } from '../utils/vipStore.ts';

const LINK_REGEX =
  /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9]+|whatsapp\.com\/channel\/[A-Za-z0-9]+|wa\.me\/[0-9]+|t\.me\/[A-Za-z0-9_]+|youtu\.be\/[^\s]+|discord\.gg\/[A-Za-z0-9]+|bit\.ly\/[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|pk|in|io|app|me|xyz|tv|link|gg|co)\/[^\s]*)/i;

export async function handleGroupParticipantsUpdate(
  sock: WASocket,
  update: BaileysEventMap['group-participants.update']
): Promise<void> {
  try {
    const groupId = update.id;
    invalidateGroupMetadataCache(groupId);
    const groupCfg = vipStore.getGroupConfig(groupId);
    const cfg = loadConfig();

    if (!groupCfg.welcome && !groupCfg.goodbye) return;

    let groupSubject = 'this group';
    try {
      const meta = await getCachedGroupMetadata(sock, groupId);
      groupSubject = meta.subject || groupSubject;
    } catch {
      // Ignore metadata fetch failure
    }

    for (const participant of update.participants) {
      const jid = typeof participant === 'string' ? participant : participant.id;
      const num = jidUserPart(jid);
      if (update.action === 'add' && groupCfg.welcome) {
        await sock.sendMessage(groupId, {
          text: `*Welcome to ${groupSubject}!*\nHello @${num}, welcome to the group.\n\n> Powered by *${cfg.botName}*`,
          mentions: [jid],
        });
      } else if (update.action === 'remove' && groupCfg.goodbye) {
        await sock.sendMessage(groupId, {
          text: `*Goodbye @${num}*\nThanks for being part of *${groupSubject}*.`,
          mentions: [jid],
        });
      }
    }
  } catch (err) {
    logger.error('groupHandler', `Participant update error: ${(err as Error).message}`);
  }
}

export async function enforceAntilink(
  sock: WASocket,
  msg: WAMessage,
  body: string,
  chatId: string,
  senderCandidates: string[],
  isOwner: boolean
): Promise<boolean> {
  if (!chatId.endsWith('@g.us') || isOwner || msg.key?.fromMe) return false;
  const groupCfg = vipStore.getGroupConfig(chatId);
  const mode = groupCfg.antilinkMode || (groupCfg.antilink ? 'delete' : 'off');
  if (mode === 'off' && !groupCfg.antilink) return false;
  if (!LINK_REGEX.test(body)) return false;

  try {
    let meta = await getCachedGroupMetadata(sock, chatId);
    const senderParticipant = findParticipant(meta.participants, senderCandidates);
    if (isParticipantAdmin(senderParticipant)) return false;

    const botJids = await getBotJids(sock);
    let botParticipant = findParticipant(meta.participants, botJids);

    // Refresh once in case the bot was recently promoted to Group Admin
    if (!isParticipantAdmin(botParticipant)) {
      meta = await getCachedGroupMetadata(sock, chatId, true);
      botParticipant = findParticipant(meta.participants, botJids);
    }

    if (!isParticipantAdmin(botParticipant)) {
      logger.warn('antilink', `Link detected in ${chatId} but bot is not Group Admin.`);
      return false;
    }

    const senderJid = senderParticipant?.id || senderCandidates[0] || chatId;
    const senderDisplay = jidUserPart(senderParticipant?.phoneNumber || senderJid);

    const deleteKey = {
      remoteJid: chatId,
      fromMe: false,
      id: msg.key.id,
      participant: msg.key.participant || senderParticipant?.id || senderJid,
    };
    await sock.sendMessage(chatId, { delete: deleteKey });

    if (mode === 'kick') {
      await sock.sendMessage(chatId, {
        text: `*Antilink Protection*\n@${senderDisplay} sent an unauthorized link and has been removed.`,
        mentions: [senderJid],
      });
      await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove').catch(() => {});
      invalidateGroupMetadataCache(chatId);
      logger.security('antilink', `Deleted link & kicked +${senderDisplay} in ${chatId}`);
    } else if (mode === 'warn') {
      const warnKey = jidUserPart(senderJid);
      const warnings = { ...(groupCfg.warnings || {}) };
      const count = (warnings[warnKey] || 0) + 1;

      if (count >= 3) {
        delete warnings[warnKey];
        vipStore.updateGroupConfig(chatId, { warnings });
        await sock.sendMessage(chatId, {
          text: `*Antilink Warning 3/3*\n@${senderDisplay} reached 3 warnings for sending links and has been removed.`,
          mentions: [senderJid],
        });
        await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove').catch(() => {});
        invalidateGroupMetadataCache(chatId);
        logger.security('antilink', `Deleted link & kicked +${senderDisplay} after 3/3 warnings in ${chatId}`);
      } else {
        warnings[warnKey] = count;
        vipStore.updateGroupConfig(chatId, { warnings });
        await sock.sendMessage(chatId, {
          text: `*Antilink Warning ${count}/3*\n@${senderDisplay}, links are not allowed here. After 3 warnings you will be automatically removed.`,
          mentions: [senderJid],
        });
        logger.security('antilink', `Deleted link & issued warning ${count}/3 to +${senderDisplay} in ${chatId}`);
      }
    } else {
      await sock.sendMessage(chatId, {
        text: `*Antilink Guard*\n@${senderDisplay}, links are not allowed in this group.`,
        mentions: [senderJid],
      });
      logger.security('antilink', `Deleted link message from +${senderDisplay} in ${chatId}`);
    }
    return true;
  } catch (err) {
    logger.warn('antilink', `Antilink check failed: ${(err as Error).message}`);
  }
  return false;
}

export async function handleAntidelete(
  sock: WASocket,
  revokedMsg: WAMessage,
  getCachedMessage: (chatId: string, msgId: string) => WAMessage | undefined
): Promise<void> {
  try {
    const chatId = revokedMsg.key?.remoteJid;
    const protocolMsg = revokedMsg.message?.protocolMessage;
    if (!chatId || !protocolMsg || protocolMsg.type !== 0 || !protocolMsg.key?.id) return;
    if (!chatId.endsWith('@g.us')) return;

    const groupCfg = vipStore.getGroupConfig(chatId);
    if (!groupCfg.antidelete) return;

    const original = getCachedMessage(chatId, protocolMsg.key.id);
    if (!original || !original.message || original.key?.fromMe) return;

    const deletedBy = revokedMsg.key?.participantAlt || revokedMsg.key?.participant || chatId;
    const senderNum = jidUserPart(deletedBy);
    const text = extractBodyText(original.message);
    if (!text) return;

    await sock.sendMessage(chatId, {
      text: `*Antidelete Recovered*\n• From: @${senderNum}\n• Deleted Message:\n${text}`,
      mentions: [deletedBy],
    });
  } catch (err) {
    logger.warn('antidelete', `Antidelete recovery failed: ${(err as Error).message}`);
  }
}
