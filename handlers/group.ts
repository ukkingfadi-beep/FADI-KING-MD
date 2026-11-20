import type { BaileysEventMap, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { loadConfig } from '../config/bot.config.ts';
import {
  extractBodyText,
  extractContextInfo,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  invalidateGroupMetadataCache,
  isParticipantAdmin,
  jidUserPart,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import { vipStore } from '../utils/vipStore.ts';

const LINK_REGEX =
  /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9]+|whatsapp\.com\/channel\/[A-Za-z0-9]+|wa\.me\/[0-9]+|t\.me\/[A-Za-z0-9_]+|youtu\.be\/[^\s]+|discord\.gg\/[A-Za-z0-9]+|bit\.ly\/[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|pk|in|io|app|me|xyz|tv|link|gg|co)\/[^\s]*)/i;

const ABUSIVE_WORDS_REGEX =
  /\b(madarchod|maderchod|bhenchod|behenchod|bhosdike|bhosdi|chutiya|chutiye|harami|haramzada|haramzadi|kamina|kameena|kutti|kutta|kutte|gandu|randi|randwa|lund|lauda|lavda|chodu|chodna|bhadwa|bhadwe|kanjar|tatti|ullu\s+ka\s+pattha|fuck(?:ing|er|ed)?|motherfucker|bitch(?:es)?|asshole|bastard|dickhead|slut|whore|cunt)\b/i;

const SCAM_PHRASE_REGEX =
  /((?:send|share|bhej|bhejo|batayen|batao)\s+(?:your\s+)?(?:otp|pin|mpin|password|verification\s*code|cvv)|(?:jazzcash|easypaisa|sadapay|nayapay).{0,45}(?:double|win|prize|reward|claim|urgent\s+verify|account\s+block)|(?:you\s+(?:have\s+)?won|congratulations.{0,30}winner|lottery\s+winner|lucky\s+draw\s+winner)|(?:earn\s+\$?\d+\s*(?:daily|per\s+day|hourly)|double\s+your\s+(?:money|investment|crypto|btc|usdt))|(?:whatsapp|bank|account)\s+(?:will\s+be\s+)?(?:banned|suspended|blocked).{0,40}(?:verify|click|otp)|aviator\s+hack|1xbet\s+hack|teen\s+patti\s+hack|crypto\s+airdrop\s+claim)/i;

const BAD_STICKER_LABEL_REGEX =
  /(18\+|nsfw|porn|xxx|nude|sex|hentai|abuse|gali|scam|fraud|betting|aviator|casino)/i;

const stickerFloodTracker = new Map<string, number[]>();
const msgFloodTracker = new Map<string, number[]>();

function recordFloodHit(
  tracker: Map<string, number[]>,
  key: string,
  windowMs: number,
  threshold: number
): boolean {
  const now = Date.now();
  const recent = (tracker.get(key) || []).filter((ts) => now - ts <= windowMs);
  recent.push(now);
  tracker.set(key, recent);

  if (tracker.size > 3000) {
    for (const [k, list] of tracker.entries()) {
      if (list.length === 0 || now - list[list.length - 1] > windowMs) {
        tracker.delete(k);
      }
    }
  }
  return recent.length >= threshold;
}

export function normalizeFileSha256(
  raw: Uint8Array | Buffer | string | null | undefined
): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  return Buffer.from(raw).toString('base64');
}

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

export async function enforceAntiScam(
  sock: WASocket,
  msg: WAMessage,
  body: string,
  chatId: string,
  senderCandidates: string[],
  isOwner: boolean
): Promise<boolean> {
  if (!chatId.endsWith('@g.us') || isOwner || msg.key?.fromMe) return false;
  const groupCfg = vipStore.getGroupConfig(chatId);
  if (!groupCfg.antiScam) return false;

  const cfg = loadConfig();
  const inner = unwrapMessage(msg.message);
  const sticker = inner?.stickerMessage;
  const contextInfo = extractContextInfo(msg.message);
  const forwardingScore = Number(contextInfo?.forwardingScore || 0);
  const mentionedCount = contextInfo?.mentionedJid?.length || 0;
  const userTrackKey = jidUserPart(
    senderCandidates[0] || msg.key?.participantAlt || msg.key?.participant || chatId
  );

  let violation: string | null = null;

  if (sticker) {
    const sha = normalizeFileSha256(sticker.fileSha256);
    if (cfg.antiScamBlockAllStickers) {
      violation = 'Unwanted Sticker (Strict Anti-Scam Mode)';
    } else if (sha && vipStore.isStickerBanned(sha)) {
      violation = 'Banned/Vulgar Sticker';
    } else if (forwardingScore >= 3) {
      violation = 'Forwarded Spam Sticker';
    } else if (
      sticker.accessibilityLabel &&
      BAD_STICKER_LABEL_REGEX.test(sticker.accessibilityLabel)
    ) {
      violation = 'Inappropriate Sticker';
    } else if (recordFloodHit(stickerFloodTracker, `${chatId}:${userTrackKey}`, 12_000, 3)) {
      violation = 'Sticker Flood Spam';
    }
  }

  if (!violation) {
    if (body && ABUSIVE_WORDS_REGEX.test(body)) {
      violation = 'Abusive Language / Gaaliyan';
    } else if (body && SCAM_PHRASE_REGEX.test(body)) {
      violation = 'Scam / Fraud / Phishing';
    } else if (mentionedCount >= 10) {
      violation = 'Mass Mention Spam';
    } else if (body.length > 2500) {
      violation = 'Text Bomb / Oversized Spam';
    } else if (body && /(.)\1{35,}/.test(body)) {
      violation = 'Character Flood Spam';
    } else if (body && /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]{12,}/.test(body)) {
      violation = 'Invisible Crash/Bug Spam';
    } else if (forwardingScore >= 5 && body.length > 80) {
      violation = 'Viral Forward Spam';
    } else if (recordFloodHit(msgFloodTracker, `${chatId}:${userTrackKey}`, 8_000, 5)) {
      violation = 'Message Flood Spam';
    }
  }

  if (!violation) return false;

  try {
    let meta = await getCachedGroupMetadata(sock, chatId);
    const senderParticipant = findParticipant(meta.participants, senderCandidates);
    if (isParticipantAdmin(senderParticipant)) return false;

    const botJids = await getBotJids(sock);
    let botParticipant = findParticipant(meta.participants, botJids);

    if (!isParticipantAdmin(botParticipant)) {
      meta = await getCachedGroupMetadata(sock, chatId, true);
      botParticipant = findParticipant(meta.participants, botJids);
    }

    if (!isParticipantAdmin(botParticipant)) {
      logger.warn('antiScam', `${violation} detected in ${chatId} but bot is not Group Admin.`);
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

    const warnKey = jidUserPart(senderJid);
    const antiScamWarnings = { ...(groupCfg.antiScamWarnings || {}) };
    const count = (antiScamWarnings[warnKey] || 0) + 1;

    if (count >= 3) {
      delete antiScamWarnings[warnKey];
      vipStore.updateGroupConfig(chatId, { antiScamWarnings });
      await sock.sendMessage(chatId, {
        text: `*Anti-Scam Shield (3/3 — Removed)*\n@${senderDisplay} was removed for *${violation}*.`,
        mentions: [senderJid],
      });
      await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove').catch(() => {});
      invalidateGroupMetadataCache(chatId);
      logger.security('antiScam', `Deleted (${violation}) & kicked +${senderDisplay} in ${chatId}`);
    } else {
      antiScamWarnings[warnKey] = count;
      vipStore.updateGroupConfig(chatId, { antiScamWarnings });
      await sock.sendMessage(chatId, {
        text: `*Anti-Scam Shield (${count}/3)*\n@${senderDisplay}, *${violation}* is not allowed here. Message deleted (3 warnings = auto kick).`,
        mentions: [senderJid],
      });
      logger.security('antiScam', `Deleted (${violation}) & warned +${senderDisplay} (${count}/3) in ${chatId}`);
    }
    return true;
  } catch (err) {
    logger.warn('antiScam', `Anti-Scam check failed: ${(err as Error).message}`);
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
