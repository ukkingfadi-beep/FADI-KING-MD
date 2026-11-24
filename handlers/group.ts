import { getUrlInfo, type BaileysEventMap, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  extractContextInfo,
  extractFirstUrl,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  invalidateGroupMetadataCache,
  isLidUser,
  isParticipantAdmin,
  jidUserPart,
  lookupKnownUserName,
  normalizeBareJid,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import { generateWelcomeImageCard, sendEncryptedPayMessage } from '../utils/mediaHelper.ts';
import { vipStore } from '../utils/vipStore.ts';

const LINK_REGEX =
  /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9]+|whatsapp\.com\/channel\/[A-Za-z0-9]+|wa\.me\/[0-9]+|t\.me\/[A-Za-z0-9_]+|youtu\.be\/[^\s]+|discord\.gg\/[A-Za-z0-9]+|bit\.ly\/[^\s]+|tinyurl\.com\/[^\s]+|shorturl\.at\/[^\s]+|(?:instagram|tiktok|facebook|twitter|x|snapchat)\.com\/[^\s]+|fb\.watch\/[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|pk|in|io|app|me|xyz|tv|link|gg|co|site|shop|online)\/[^\s]*)/i;

const ABUSIVE_WORDS_REGEX =
  /(?:\b(madarchod|maderchod|madar\s*chod|bhenchod|behenchod|bhosdike|bhosdika|bhosdi|bsdk|bkl|mc|bc|mkc|bhen\s*ke\s*lode|chutiya|chutiye|chutiyapa|chut|choot|harami|haramzada|haramzadi|haramkhor|kamina|kameena|kameene|kutti|kutta|kutte|kamine|gandu|gaand|gand|randi|randwa|randi\s*ka|lund|lauda|lavda|loda|lodu|chodu|chodna|chod|bhadwa|bhadwe|kanjar|kanjri|tatti|suwar|suar|ullu\s+ka\s+pattha|teri\s+ma+|teri\s+behan|maa\s+ki\s+chut|fuck(?:ing|er|ed|off)?|motherfucker|bitch(?:es|ing)?|asshole|bastard|dickhead|dick|cock|pussy|slut|whore|cunt|bullshit|shit)\b|(?:m[\W_]*a[\W_]*d[\W_]*a[\W_]*r[\W_]*c[\W_]*h[\W_]*o[\W_]*d|b[\W_]*h[\W_]*e[\W_]*n[\W_]*c[\W_]*h[\W_]*o[\W_]*d|c[\W_]*h[\W_]*u[\W_]*t[\W_]*i[\W_]*y[\W_]*a|b[\W_]*h[\W_]*o[\W_]*s[\W_]*d[\W_]*i))/i;

const SCAM_PHRASE_REGEX =
  /((?:send|share|bhej|bhejo|batayen|batao)\s+(?:your\s+)?(?:otp|pin|mpin|password|verification\s*code|cvv)|(?:jazzcash|easypaisa|sadapay|nayapay).{0,45}(?:double|win|prize|reward|claim|urgent\s+verify|account\s+block)|(?:you\s+(?:have\s+)?won|congratulations.{0,30}winner|lottery\s+winner|lucky\s+draw\s+winner)|(?:earn\s+\$?\d+\s*(?:daily|per\s+day|hourly)|double\s+your\s+(?:money|investment|crypto|btc|usdt))|(?:whatsapp|bank|account)\s+(?:will\s+be\s+)?(?:banned|suspended|blocked).{0,40}(?:verify|click|otp)|aviator\s+hack|1xbet\s+hack|teen\s+patti\s+hack|crypto\s+airdrop\s+claim)/i;

const BAD_MEDIA_LABEL_REGEX =
  /\b(18\+|nsfw|porn|porno|xxx|nude|nudes|naked|sex|sexy|hentai|xvideos|xnxx|onlyfans|adult\s*video|gandi|chudai|chod|lund|chut|randi|abuse|gali|scam|fraud|betting|aviator|casino)\b/i;

const stickerFloodTracker = new Map<string, number[]>();
const msgFloodTracker = new Map<string, number[]>();
const kickAllTracker = new Map<string, number[]>();

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

async function expandActorKeys(
  sock: WASocket,
  rawAuthor: string,
  extraAuthorPn?: string
): Promise<string[]> {
  const set = new Set<string>();
  const add = (val?: string | null) => {
    const bare = normalizeBareJid(val);
    if (bare) set.add(bare);
  };
  add(rawAuthor);
  add(extraAuthorPn);
  for (const item of Array.from(set)) {
    if (isLidUser(item) && sock.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(item);
        if (pn) add(pn);
      } catch {
        // Ignore unavailable LID mapping
      }
    }
  }
  return Array.from(set);
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

    const updateExtra = update as { author?: string; authorPn?: string };
    const authorRaw = updateExtra.author || '';
    const authorPnRaw = updateExtra.authorPn || '';

    // 1. Anti-Add & Anti-Bot check on newly added participants
    if (update.action === 'add' && (groupCfg.antiAdd || groupCfg.antiBot) && cfg.mode !== 'self') {
      try {
        const meta = await getCachedGroupMetadata(sock, groupId, true);
        const botJids = await getBotJids(sock);
        const botParticipant = findParticipant(meta.participants, botJids);
        const botIsAdmin = isParticipantAdmin(botParticipant);
        const ownerNum = normalizePhone(cfg.ownerNumber);

        const actorCandidates = await expandActorKeys(sock, authorRaw, authorPnRaw);
        const authorBare = actorCandidates[0] || '';
        const authorParticipant = actorCandidates.length
          ? findParticipant(meta.participants, actorCandidates)
          : undefined;
        const actorUserParts = new Set(
          [
            ...actorCandidates.map((c) => jidUserPart(c)),
            jidUserPart(authorParticipant?.id),
            jidUserPart(authorParticipant?.phoneNumber),
          ].filter(Boolean)
        );
        const authorIsBot = botJids.some((b) => actorUserParts.has(jidUserPart(b)));
        const authorIsOwner = Boolean(
          ownerNum && Array.from(actorUserParts).some((u) => normalizePhone(u) === ownerNum)
        );
        const authorIsAdmin = isParticipantAdmin(authorParticipant) || authorIsBot || authorIsOwner;

        if (botIsAdmin) {
          for (const participant of update.participants) {
            const pObj = typeof participant === 'string' ? { id: participant } : participant;
            const rawJid = pObj.id;
            const bareAdded = normalizeBareJid(rawJid);
            if (!bareAdded) continue;
            if (botJids.some((b) => jidUserPart(b) === jidUserPart(bareAdded))) continue;

            const addedIsBot = bareAdded.endsWith('@bot');
            const wasAddedByNonAdmin = Boolean(
              groupCfg.antiAdd &&
                authorBare &&
                !actorUserParts.has(jidUserPart(bareAdded)) &&
                !authorIsAdmin
            );

            if ((groupCfg.antiBot && addedIsBot) || wasAddedByNonAdmin) {
              await sock.groupParticipantsUpdate(groupId, [rawJid], 'remove').catch(() => {});
              invalidateGroupMetadataCache(groupId);
              const targetTag = jidUserPart(bareAdded);
              const reasonText =
                groupCfg.antiBot && addedIsBot
                  ? `*Anti-Bot Guard*\nUnauthorized bot @${targetTag} was automatically removed.`
                  : `*Anti-Add Guard*\n@${jidUserPart(authorBare)} is not allowed to add members here. Removed @${targetTag}.`;
              await sock
                .sendMessage(groupId, {
                  text: reasonText,
                  mentions: [rawJid, ...(authorBare ? [authorBare] : [])],
                })
                .catch(() => {});
              logger.security(
                'groupGuard',
                `Removed ${bareAdded} from ${groupId} (antiAdd=${Boolean(groupCfg.antiAdd)}, antiBot=${Boolean(groupCfg.antiBot)})`
              );
            }
          }
        }
      } catch (guardErr) {
        logger.warn('groupGuard', `Participant guard error in ${groupId}: ${(guardErr as Error).message}`);
      }
    }

    // 2. Anti-Admin Guard: Only Bot itself, Bot Owner, or Group Creator can promote admins
    if (update.action === 'promote' && groupCfg.antiAdmin && cfg.mode !== 'self') {
      try {
        const meta = await getCachedGroupMetadata(sock, groupId, true);
        const botJids = await getBotJids(sock);
        const botParticipant = findParticipant(meta.participants, botJids);
        if (isParticipantAdmin(botParticipant)) {
          const ownerNum = normalizePhone(cfg.ownerNumber);
          const actorCandidates = await expandActorKeys(sock, authorRaw, authorPnRaw);
          const actorParticipant = actorCandidates.length
            ? findParticipant(meta.participants, actorCandidates)
            : undefined;
          const actorParts = new Set(
            [
              ...actorCandidates.map((c) => jidUserPart(c)),
              jidUserPart(actorParticipant?.id),
              jidUserPart(actorParticipant?.phoneNumber),
            ].filter(Boolean)
          );

          const creatorParts = new Set(
            [
              jidUserPart(meta.owner),
              jidUserPart(meta.ownerPn),
              ...meta.participants
                .filter((p) => p.admin === 'superadmin')
                .flatMap((p) => [jidUserPart(p.id), jidUserPart(p.phoneNumber)]),
            ].filter(Boolean)
          );

          const actorIsBot = botJids.some((b) => actorParts.has(jidUserPart(b)));
          const actorIsOwner = Boolean(
            ownerNum && Array.from(actorParts).some((u) => normalizePhone(u) === ownerNum)
          );
          const actorIsCreator =
            actorParticipant?.admin === 'superadmin' ||
            Array.from(actorParts).some((u) => creatorParts.has(u));

          if (!actorIsBot && !actorIsOwner && !actorIsCreator) {
            const targetsToDemote: string[] = [];
            for (const participant of update.participants) {
              const pObj = typeof participant === 'string' ? { id: participant } : participant;
              const rawJid = pObj.id;
              const pnPart = jidUserPart((pObj as { phoneNumber?: string }).phoneNumber);
              const uPart = jidUserPart(rawJid);
              const isTargetBot = botJids.some((b) => jidUserPart(b) === uPart || jidUserPart(b) === pnPart);
              const isTargetOwner = Boolean(
                ownerNum &&
                  (normalizePhone(uPart) === ownerNum || normalizePhone(pnPart) === ownerNum)
              );
              if (!isTargetBot && !isTargetOwner) {
                targetsToDemote.push(rawJid);
              }
            }

            if (targetsToDemote.length > 0) {
              await sock.groupParticipantsUpdate(groupId, targetsToDemote, 'demote').catch(() => {});
              invalidateGroupMetadataCache(groupId);
              const actorJid = actorParticipant?.id || actorCandidates[0] || '';
              const actorTag = actorJid ? `@${jidUserPart(actorJid)}` : 'An admin';
              const targetTags = targetsToDemote.map((t) => `@${jidUserPart(t)}`).join(', ');
              const mentions = Array.from(
                new Set([...targetsToDemote, ...(actorJid ? [actorJid] : [])])
              );
              await sock
                .sendMessage(groupId, {
                  text: `🛡️ *Anti-Admin Guard*\nOnly the *Group Creator* or *Bot Owner* can promote members here.\n• Unauthorized promotion by: ${actorTag}\n• Automatically demoted: ${targetTags}`,
                  mentions,
                })
                .catch(() => {});
              logger.security(
                'antiAdmin',
                `Reverted unauthorized promotion of [${targetsToDemote.join(', ')}] by ${actorJid || 'unknown'} in ${groupId}`
              );
            }
          }
        }
      } catch (err) {
        logger.warn('antiAdmin', `Anti-Admin check failed in ${groupId}: ${(err as Error).message}`);
      }
    }

    // 3. Anti-KickAll Guard: When ON, demote non-creator/non-owner admin performing bulk/rapid kicks (no re-add)
    if (update.action === 'remove' && groupCfg.antiKickAll && cfg.mode !== 'self' && authorRaw) {
      try {
        const meta = await getCachedGroupMetadata(sock, groupId, true);
        const botJids = await getBotJids(sock);
        const botParticipant = findParticipant(meta.participants, botJids);
        if (isParticipantAdmin(botParticipant)) {
          const ownerNum = normalizePhone(cfg.ownerNumber);
          const actorCandidates = await expandActorKeys(sock, authorRaw, authorPnRaw);
          const actorParticipant = actorCandidates.length
            ? findParticipant(meta.participants, actorCandidates)
            : undefined;
          const actorParts = new Set(
            [
              ...actorCandidates.map((c) => jidUserPart(c)),
              jidUserPart(actorParticipant?.id),
              jidUserPart(actorParticipant?.phoneNumber),
            ].filter(Boolean)
          );

          const creatorParts = new Set(
            [
              jidUserPart(meta.owner),
              jidUserPart(meta.ownerPn),
              ...meta.participants
                .filter((p) => p.admin === 'superadmin')
                .flatMap((p) => [jidUserPart(p.id), jidUserPart(p.phoneNumber)]),
            ].filter(Boolean)
          );

          const actorIsBot = botJids.some((b) => actorParts.has(jidUserPart(b)));
          const actorIsOwner = Boolean(
            ownerNum && Array.from(actorParts).some((u) => normalizePhone(u) === ownerNum)
          );
          const actorIsCreator =
            actorParticipant?.admin === 'superadmin' ||
            Array.from(actorParts).some((u) => creatorParts.has(u));

          if (!actorIsBot && !actorIsOwner && !actorIsCreator) {
            let nonSelfRemoved = 0;
            for (const participant of update.participants) {
              const pObj = typeof participant === 'string' ? { id: participant } : participant;
              const tUser = jidUserPart(pObj.id);
              const tPn = jidUserPart((pObj as { phoneNumber?: string }).phoneNumber);
              if (actorParts.has(tUser) || (tPn && actorParts.has(tPn))) {
                continue; // Member left voluntarily
              }
              nonSelfRemoved += 1;
            }

            if (nonSelfRemoved > 0) {
              const actorKey =
                jidUserPart(actorParticipant?.phoneNumber || actorParticipant?.id || actorCandidates[0]) ||
                jidUserPart(authorRaw);
              const trackKey = `${groupId}:${actorKey}`;
              const now = Date.now();
              const recent = (kickAllTracker.get(trackKey) || []).filter((ts) => now - ts <= 12_000);
              for (let i = 0; i < nonSelfRemoved; i += 1) {
                recent.push(now);
              }
              kickAllTracker.set(trackKey, recent);

              if (kickAllTracker.size > 2000) {
                for (const [k, list] of kickAllTracker.entries()) {
                  if (!list.length || now - list[list.length - 1] > 12_000) {
                    kickAllTracker.delete(k);
                  }
                }
              }

              if (recent.length >= 2) {
                kickAllTracker.delete(trackKey);
                const actorTargetJid = actorParticipant?.id || actorCandidates[0] || authorRaw;
                if (actorTargetJid) {
                  await sock
                    .groupParticipantsUpdate(groupId, [actorTargetJid], 'demote')
                    .catch(() => {});
                  invalidateGroupMetadataCache(groupId);
                  await sock
                    .sendMessage(groupId, {
                      text: `🛑 *Anti-KickAll Shield*\nMass-kick / kickall attempt detected by @${jidUserPart(actorTargetJid)}.\nThey have been automatically *demoted from Admin* to protect the group.`,
                      mentions: [actorTargetJid],
                    })
                    .catch(() => {});
                  logger.security(
                    'antiKickAll',
                    `Demoted ${actorTargetJid} after ${recent.length} removals in ${groupId}`
                  );
                }
              }
            }
          }
        }
      } catch (err) {
        logger.warn('antiKickAll', `Anti-KickAll check failed in ${groupId}: ${(err as Error).message}`);
      }
    }

    // 4. Welcome / Welcome Image Card / Goodbye Messages
    if (!groupCfg.welcome && !groupCfg.welcomeImg && !groupCfg.goodbye) return;
    if (cfg.mode === 'self') return;

    let cachedGroupMeta: Awaited<ReturnType<typeof getCachedGroupMetadata>> | null = null;
    if (update.action === 'add' && groupCfg.welcomeImg) {
      cachedGroupMeta = await getCachedGroupMetadata(sock, groupId).catch(() => null);
    }

    for (const participant of update.participants) {
      const pObj = typeof participant === 'string' ? { id: participant } : participant;
      const rawJid = pObj.id;
      const pnFromObj = (pObj as { phoneNumber?: string }).phoneNumber;
      let targetDm = pnFromObj || rawJid;

      if (isLidUser(targetDm) && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const mapped = await sock.signalRepository.lidMapping.getPNForLID(targetDm);
          if (mapped) targetDm = mapped;
        } catch {
          // Ignore missing LID mapping
        }
      }
      targetDm = normalizeBareJid(targetDm) || rawJid;

      const num = jidUserPart(targetDm);
      const mentionUser = jidUserPart(rawJid) || num;

      if (update.action === 'add' && groupCfg.welcomeImg) {
        try {
          let avatarBuf: Buffer | null = null;
          const ppCandidates = Array.from(new Set([rawJid, targetDm].filter(Boolean)));
          for (const jidCandidate of ppCandidates) {
            let ppUrl: string | undefined;
            try {
              ppUrl = await sock.profilePictureUrl(jidCandidate, 'image');
            } catch {
              ppUrl = await sock.profilePictureUrl(jidCandidate, 'preview').catch(() => undefined);
            }
            if (ppUrl) {
              try {
                const res = await fetch(ppUrl, { signal: AbortSignal.timeout(8000) });
                if (res.ok) {
                  avatarBuf = Buffer.from(await res.arrayBuffer());
                  if (avatarBuf.length > 0) break;
                }
              } catch {
                avatarBuf = null;
              }
            }
          }

          const notifyName = (pObj as { notify?: string }).notify;
          const memberName =
            notifyName ||
            lookupKnownUserName(rawJid) ||
            lookupKnownUserName(targetDm) ||
            (num ? `+${num}` : 'New Member');
          const groupName = cachedGroupMeta?.subject || 'WhatsApp Group';
          const memberCount = cachedGroupMeta?.participants?.length || 1;

          const cardBuffer = await generateWelcomeImageCard({
            memberName,
            memberNumber: num || mentionUser,
            groupName,
            memberCount,
            avatarBuffer: avatarBuf,
            botName: cfg.botName || 'FADI KING MD',
          });

          await sock
            .sendMessage(groupId, {
              image: cardBuffer,
              caption: `🎉 *Welcome @${mentionUser || num} to ${groupName}!*\n• Member #${memberCount}`,
              mentions: [rawJid],
            })
            .catch(() => {});
          continue;
        } catch (cardErr) {
          logger.warn('welcomeImg', `Card generation failed in ${groupId}: ${(cardErr as Error).message}`);
          // Fallback gracefully to text welcome if card failed
        }
      }

      if (update.action === 'add' && (groupCfg.welcome || groupCfg.welcomeImg)) {
        await sock
          .sendMessage(groupId, {
            text: `*_${mentionUser ? `@${mentionUser}` : 'Welcome'} joined the group, welcome!_* 🎉`,
            mentions: [rawJid],
          })
          .catch(() => {});
      } else if (update.action === 'remove' && groupCfg.goodbye) {
        await sock.sendMessage(groupId, {
          text: `*Goodbye @${mentionUser || num}*\nWishing you all the best ahead.`,
          mentions: [rawJid],
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
  const imageMsg = inner?.imageMessage;
  const videoMsg = inner?.videoMessage;
  const docMsg = inner?.documentMessage;
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
      BAD_MEDIA_LABEL_REGEX.test(sticker.accessibilityLabel)
    ) {
      violation = 'Inappropriate Sticker';
    } else if (recordFloodHit(stickerFloodTracker, `${chatId}:${userTrackKey}`, 12_000, 3)) {
      violation = 'Sticker Flood Spam';
    }
  }

  if (!violation && (imageMsg || videoMsg || docMsg)) {
    const mediaSha = normalizeFileSha256(
      imageMsg?.fileSha256 || videoMsg?.fileSha256 || docMsg?.fileSha256
    );
    const mediaMetaText = [
      imageMsg?.accessibilityLabel,
      imageMsg?.caption,
      videoMsg?.accessibilityLabel,
      videoMsg?.caption,
      docMsg?.fileName,
      docMsg?.caption,
    ]
      .filter(Boolean)
      .join(' ');

    if (mediaSha && vipStore.isStickerBanned(mediaSha)) {
      violation = imageMsg ? 'Banned/Inappropriate Photo' : videoMsg ? 'Banned/Inappropriate Video' : 'Banned File';
    } else if (mediaMetaText && (BAD_MEDIA_LABEL_REGEX.test(mediaMetaText) || ABUSIVE_WORDS_REGEX.test(mediaMetaText))) {
      violation = imageMsg ? 'Inappropriate Photo (18+/Abuse)' : videoMsg ? 'Inappropriate Video (18+/Abuse)' : 'Inappropriate Media';
    } else if (forwardingScore >= 4 && (imageMsg || videoMsg)) {
      violation = imageMsg ? 'Viral Forwarded Spam Photo' : 'Viral Forwarded Spam Video';
    } else if ((imageMsg || videoMsg) && recordFloodHit(stickerFloodTracker, `${chatId}:media:${userTrackKey}`, 12_000, 4)) {
      violation = 'Media Flood Spam';
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

export async function enforceAntiStatusMention(
  sock: WASocket,
  msg: WAMessage,
  body: string,
  chatId: string,
  senderCandidates: string[],
  isOwner: boolean
): Promise<boolean> {
  if (!chatId.endsWith('@g.us') || isOwner || msg.key?.fromMe) return false;
  const groupCfg = vipStore.getGroupConfig(chatId);
  if (!groupCfg.antiStatusMention) return false;

  const inner = unwrapMessage(msg.message);
  const ctxInfo = extractContextInfo(msg.message) as
    | (Record<string, unknown> & { statusMentionMessageInfo?: unknown; statusMentions?: unknown[] })
    | undefined;
  const rawMsg = (msg.message || {}) as Record<string, unknown>;
  const msgCtx = rawMsg.messageContextInfo as
    | { statusMentionMessageInfo?: unknown; statusMentions?: unknown[] }
    | undefined;

  const isStatusMention = Boolean(
    rawMsg.groupStatusMentionMessage ||
      rawMsg.statusMentionMessage ||
      rawMsg.groupStatusMessage ||
      rawMsg.groupStatusMessageV2 ||
      inner?.groupStatusMentionMessage ||
      inner?.statusMentionMessage ||
      inner?.groupStatusMessage ||
      inner?.groupStatusMessageV2 ||
      ctxInfo?.remoteJid === 'status@broadcast' ||
      msgCtx?.statusMentionMessageInfo ||
      (Array.isArray(msgCtx?.statusMentions) && msgCtx.statusMentions.length > 0) ||
      ctxInfo?.statusMentionMessageInfo ||
      (Array.isArray(ctxInfo?.statusMentions) && ctxInfo.statusMentions.length > 0) ||
      (body && /status\s*mention|mentioned\s+this\s+group\s+in\s+(?:their|a)\s+status/i.test(body))
  );

  if (!isStatusMention) return false;

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
      logger.warn('antiMention', `Status mention detected in ${chatId} but bot is not Group Admin.`);
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
    await sock.sendMessage(chatId, {
      text: `*Anti-Mention Status*\n@${senderDisplay}, mentioning this group in your WhatsApp Status is not allowed here.`,
      mentions: [senderJid],
    });
    logger.security('antiMention', `Deleted group status mention from +${senderDisplay} in ${chatId}`);
    return true;
  } catch (err) {
    logger.warn('antiMention', `Anti-Status-Mention check failed: ${(err as Error).message}`);
  }
  return false;
}

export async function dispatchOpenGcProtectedPost(
  sock: WASocket,
  textPayload: string
): Promise<{ sent: number; totalOpen: number }> {
  const groupsMap = await sock.groupFetchAllParticipating();
  const openGroups = Object.values(groupsMap).filter((g) => !g.announce && !g.isCommunityAnnounce);
  if (openGroups.length === 0) {
    return { sent: 0, totalOpen: 0 };
  }

  let urlInfo: Awaited<ReturnType<typeof getUrlInfo>> | undefined;
  if (extractFirstUrl(textPayload)) {
    urlInfo = await getUrlInfo(textPayload, {
      thumbnailWidth: 192,
      fetchOpts: { timeout: 3500 },
      uploadImage: sock.waUploadToServer,
    }).catch(() => undefined);
  }

  let sent = 0;
  for (let i = 0; i < openGroups.length; i += 1) {
    const gc = openGroups[i];
    try {
      const result = await sock.sendMessage(
        gc.id,
        urlInfo ? { text: textPayload, linkPreview: urlInfo } : { text: textPayload }
      );
      sent += 1;
      if (result?.key?.id) {
        vipStore.registerProtectedPost(result.key.id, gc.id, textPayload, 0);
      }
    } catch (err) {
      logger.warn('protectedPost', `Failed open-GC send to ${gc.id}: ${(err as Error).message}`);
    }
    if (i < openGroups.length - 1) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return { sent, totalOpen: openGroups.length };
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

    // 1. Protected Open-GC / PayMsg Anti-Delete Lock: even if a Group Admin deletes it, immediately repost!
    const protectedPost = vipStore.consumeProtectedPost(chatId, protocolMsg.key.id);
    if (protectedPost) {
      if (protectedPost.repostCount < 10) {
        if (protectedPost.paymsg) {
          const resentPay = await sendEncryptedPayMessage(sock, {
            chatId,
            finalText: protectedPost.paymsg.finalText,
            linkUrl: protectedPost.paymsg.linkUrl,
            currency: protectedPost.paymsg.currency,
            amount1000: protectedPost.paymsg.amount1000,
            requestFrom: protectedPost.paymsg.requestFrom,
          }).catch(() => null);
          if (resentPay?.keyId) {
            vipStore.registerProtectedPost(
              resentPay.keyId,
              chatId,
              protectedPost.text,
              protectedPost.repostCount + 1,
              protectedPost.paymsg
            );
          }
        } else {
          const resent = await sock.sendMessage(chatId, { text: protectedPost.text }).catch(() => null);
          if (resent?.key?.id) {
            vipStore.registerProtectedPost(
              resent.key.id,
              chatId,
              protectedPost.text,
              protectedPost.repostCount + 1
            );
          }
        }
        logger.security(
          'protectedPost',
          `Deleted protected message in ${chatId}; auto-restored (attempt ${protectedPost.repostCount + 1}).`
        );
      }
      return;
    }

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

const slowModeLastSeen = new Map<string, number>();
const slowModeNoticeCooldown = new Map<string, number>();
const guardWarnCooldown = new Map<string, number>();

function canSendGuardNotice(key: string, cooldownMs = 10_000): boolean {
  const now = Date.now();
  const prev = guardWarnCooldown.get(key) || 0;
  if (now - prev < cooldownMs) return false;
  guardWarnCooldown.set(key, now);
  if (guardWarnCooldown.size > 2000) {
    for (const [k, ts] of guardWarnCooldown.entries()) {
      if (now - ts > 60_000) guardWarnCooldown.delete(k);
    }
  }
  return true;
}

function isAutomatedBotMessage(msg: WAMessage, senderCandidates: string[]): boolean {
  if (senderCandidates.some((c) => c.endsWith('@bot'))) return true;
  if (msg.message?.botInvokeMessage) return true;
  const msgId = msg.key?.id || '';
  // Other Baileys / MD automated bot stanza prefixes (not sent from official WA mobile/web clients)
  if (/^BAE5[0-9A-F]{12}$/i.test(msgId)) return true;
  if (/^3EB0[0-9A-F]{16,}$/i.test(msgId)) return true;
  return false;
}

export async function enforceAdvancedGroupGuards(
  sock: WASocket,
  msg: WAMessage,
  chatId: string,
  senderCandidates: string[],
  isOwner: boolean
): Promise<boolean> {
  if (!chatId.endsWith('@g.us') || isOwner || msg.key?.fromMe) return false;
  const groupCfg = vipStore.getGroupConfig(chatId);

  const mutedMap = groupCfg.mutedUsers || {};
  const hasMutedEntries = Object.keys(mutedMap).length > 0;
  const slowSeconds = Number(groupCfg.slowModeSeconds || 0);
  const anyGuardEnabled =
    hasMutedEntries ||
    slowSeconds > 0 ||
    Boolean(groupCfg.antiBot) ||
    Boolean(groupCfg.antiForward) ||
    Boolean(groupCfg.antiMedia) ||
    Boolean(groupCfg.antiSticker);

  if (!anyGuardEnabled) return false;

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
    const botIsAdmin = isParticipantAdmin(botParticipant);

    const senderJid = senderParticipant?.id || senderCandidates[0] || chatId;
    const senderKey = jidUserPart(senderParticipant?.phoneNumber || senderJid);
    const now = Date.now();

    const deleteCurrentMsg = async () => {
      if (!botIsAdmin || !msg.key?.id) return;
      await sock
        .sendMessage(chatId, {
          delete: {
            remoteJid: chatId,
            fromMe: false,
            id: msg.key.id,
            participant: msg.key.participant || senderParticipant?.id || senderJid,
          },
        })
        .catch(() => {});
    };

    // 1. Muted User Check (prune expired records lazily)
    if (hasMutedEntries) {
      const candidateKeys = Array.from(
        new Set([senderKey, ...senderCandidates.map((c) => jidUserPart(c))].filter(Boolean))
      );
      let activeMuteKey: string | null = null;
      let expiredFound = false;
      const nextMuted = { ...mutedMap };

      for (const [k, rec] of Object.entries(nextMuted)) {
        if (!rec || rec.expiresAt <= now) {
          delete nextMuted[k];
          expiredFound = true;
        } else if (candidateKeys.includes(k)) {
          activeMuteKey = k;
        }
      }
      if (expiredFound) {
        vipStore.updateGroupConfig(chatId, { mutedUsers: nextMuted });
      }
      if (activeMuteKey) {
        await deleteCurrentMsg();
        return true;
      }
    }

    // 2. Anti-Bot Check
    if (groupCfg.antiBot && isAutomatedBotMessage(msg, senderCandidates)) {
      await deleteCurrentMsg();
      if (botIsAdmin) {
        await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove').catch(() => {});
        invalidateGroupMetadataCache(chatId);
        await sock
          .sendMessage(chatId, {
            text: `*Anti-Bot Shield*\nRemoved automated bot account @${senderKey}.`,
            mentions: [senderJid],
          })
          .catch(() => {});
        logger.security('antiBot', `Kicked bot +${senderKey} in ${chatId}`);
      }
      return true;
    }

    // 3. Anti-Forward Check
    const inner = unwrapMessage(msg.message);
    const ctxInfo = extractContextInfo(msg.message);
    const isForwardedMsg = Boolean(
      ctxInfo?.isForwarded || Number(ctxInfo?.forwardingScore || 0) >= 1
    );
    if (groupCfg.antiForward && isForwardedMsg) {
      if (!botIsAdmin) return false;
      await deleteCurrentMsg();
      if (canSendGuardNotice(`fwd:${chatId}:${senderKey}`)) {
        await sock
          .sendMessage(chatId, {
            text: `*Anti-Forward Guard*\n@${senderKey}, forwarded messages are not allowed in this group.`,
            mentions: [senderJid],
          })
          .catch(() => {});
      }
      return true;
    }

    // 4. Anti-Sticker Check
    if (groupCfg.antiSticker && inner?.stickerMessage) {
      if (!botIsAdmin) return false;
      await deleteCurrentMsg();
      if (canSendGuardNotice(`stk:${chatId}:${senderKey}`)) {
        await sock
          .sendMessage(chatId, {
            text: `*Anti-Sticker Guard*\n@${senderKey}, stickers are disabled in this group.`,
            mentions: [senderJid],
          })
          .catch(() => {});
      }
      return true;
    }

    // 5. Anti-Media Check (images, videos, ptv, audio/voice notes, documents)
    const isMediaMsg = Boolean(
      inner?.imageMessage ||
        inner?.videoMessage ||
        inner?.ptvMessage ||
        inner?.audioMessage ||
        inner?.documentMessage
    );
    if (groupCfg.antiMedia && isMediaMsg) {
      if (!botIsAdmin) return false;
      await deleteCurrentMsg();
      if (canSendGuardNotice(`med:${chatId}:${senderKey}`)) {
        await sock
          .sendMessage(chatId, {
            text: `*Anti-Media Guard*\n@${senderKey}, media files and voice notes are not allowed in this group.`,
            mentions: [senderJid],
          })
          .catch(() => {});
      }
      return true;
    }

    // 6. Slow Mode Cooldown Check
    if (slowSeconds > 0 && senderKey) {
      const trackKey = `${chatId}:${senderKey}`;
      const lastAt = slowModeLastSeen.get(trackKey) || 0;
      const elapsedMs = now - lastAt;
      if (elapsedMs < slowSeconds * 1000) {
        const waitSec = Math.max(1, Math.ceil((slowSeconds * 1000 - elapsedMs) / 1000));
        await deleteCurrentMsg();
        const prevNotice = slowModeNoticeCooldown.get(trackKey) || 0;
        if (now - prevNotice >= 8_000) {
          slowModeNoticeCooldown.set(trackKey, now);
          await sock
            .sendMessage(chatId, {
              text: `🐢 *Slow Mode Active (${slowSeconds}s)*\n@${senderKey}, please wait *${waitSec}s* before sending another message.`,
              mentions: [senderJid],
            })
            .catch(() => {});
        }
        return true;
      }
      slowModeLastSeen.set(trackKey, now);
      if (slowModeLastSeen.size > 5000) {
        for (const [k, ts] of slowModeLastSeen.entries()) {
          if (now - ts > 3600_000) slowModeLastSeen.delete(k);
        }
      }
    }
  } catch (err) {
    logger.warn('groupGuard', `Advanced guard failed in ${chatId}: ${(err as Error).message}`);
  }
  return false;
}
