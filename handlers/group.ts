import { getUrlInfo, type BaileysEventMap, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  extractContextInfo,
  extractFirstUrl,
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  getGroupMetadataFromCacheOnly,
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
const knownGroupAdminsCache = new Map<string, Set<string>>();
const groupParticipantQueue = new Map<string, Promise<void>>();

export function recordKnownGroupAdmins(
  groupId: string,
  participants: Array<{
    id?: string | null;
    lid?: string | null;
    phoneNumber?: string | null;
    admin?: string | null;
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
  }>,
  forcePersist = false
): void {
  if (!groupId || !Array.isArray(participants)) return;
  const adminKeys = new Set<string>();
  const adminPnMap: Record<string, string> = {};

  for (const p of participants) {
    if (
      p.admin === 'admin' ||
      p.admin === 'superadmin' ||
      p.isAdmin ||
      p.isSuperAdmin
    ) {
      const pnJidRaw = [p.phoneNumber, p.id, p.lid]
        .map((v) => normalizeBareJid(v))
        .find((v) => v && v.endsWith('@s.whatsapp.net'));

      for (const raw of [p.id, p.lid, p.phoneNumber]) {
        const part = jidUserPart(raw);
        if (part) {
          adminKeys.add(part);
          if (pnJidRaw) adminPnMap[part] = pnJidRaw;
        }
      }
    }
  }

  knownGroupAdminsCache.set(groupId, adminKeys);
  if (knownGroupAdminsCache.size > 2500) {
    const oldest = knownGroupAdminsCache.keys().next().value;
    if (oldest) knownGroupAdminsCache.delete(oldest);
  }

  const groupCfg = vipStore.getGroupConfig(groupId);
  if (forcePersist || groupCfg.antiAdminKick) {
    const nextAdmins = Array.from(adminKeys).sort();
    const prevAdmins = [...(groupCfg.knownAdmins || [])].sort();
    const mergedPns = { ...(groupCfg.knownAdminPns || {}), ...adminPnMap };
    const adminsChanged =
      nextAdmins.length !== prevAdmins.length ||
      nextAdmins.some((val, idx) => val !== prevAdmins[idx]);
    const pnsChanged = Object.entries(adminPnMap).some(
      ([k, v]) => groupCfg.knownAdminPns?.[k] !== v
    );
    if (adminsChanged || pnsChanged) {
      vipStore.updateGroupConfig(groupId, {
        knownAdmins: nextAdmins,
        knownAdminPns: mergedPns,
      });
    }
  }
}

export async function syncGroupAdminSnapshot(
  sock: WASocket,
  groupId: string,
  forceRefresh = false
): Promise<void> {
  if (!groupId.endsWith('@g.us')) return;
  try {
    const meta = await getCachedGroupMetadata(sock, groupId, forceRefresh);
    recordKnownGroupAdmins(groupId, meta.participants || [], forceRefresh);
  } catch {
    // Ignore transient group metadata error
  }
}

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
  const groupId = update?.id;
  if (!groupId) return;
  const previous = groupParticipantQueue.get(groupId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => processGroupParticipantsUpdate(sock, update))
    .finally(() => {
      if (groupParticipantQueue.get(groupId) === next) {
        groupParticipantQueue.delete(groupId);
      }
    });
  groupParticipantQueue.set(groupId, next);
  return next;
}

async function processGroupParticipantsUpdate(
  sock: WASocket,
  update: BaileysEventMap['group-participants.update']
): Promise<void> {
  try {
    const groupId = update.id;
    // Snapshot prior admins BEFORE invalidating cache so removed admins are still known
    // even if the 60s metadata TTL already expired or server restarted.
    const priorMeta = await getGroupMetadataFromCacheOnly(groupId, true);
    const groupCfg = vipStore.getGroupConfig(groupId);
    const priorAdminKeys = new Set<string>([
      ...(knownGroupAdminsCache.get(groupId) || []),
      ...(groupCfg.knownAdmins || []),
    ]);
    const priorAdminPnMap: Record<string, string> = { ...(groupCfg.knownAdminPns || {}) };
    if (priorMeta?.participants) {
      for (const p of priorMeta.participants) {
        if (isParticipantAdmin(p)) {
          const pnJidRaw = [p.phoneNumber, p.id, p.lid]
            .map((v) => normalizeBareJid(v))
            .find((v) => v && v.endsWith('@s.whatsapp.net'));
          for (const raw of [p.id, p.lid, p.phoneNumber]) {
            const u = jidUserPart(raw);
            if (u) {
              priorAdminKeys.add(u);
              if (pnJidRaw) priorAdminPnMap[u] = pnJidRaw;
            }
          }
        }
      }
    }

    invalidateGroupMetadataCache(groupId);
    const cfg = loadConfig();

    const updateExtra = update as { author?: string; authorPn?: string };
    const authorRaw = updateExtra.author || '';
    const authorPnRaw = updateExtra.authorPn || '';
    const restoredUserParts = new Set<string>();

    if (update.action === 'promote') {
      const adminSet = new Set<string>(priorAdminKeys);
      for (const participant of update.participants) {
        const pObj = typeof participant === 'string' ? { id: participant } : participant;
        const rawJid = normalizeBareJid(pObj.id);
        const pnJid = normalizeBareJid((pObj as { phoneNumber?: string }).phoneNumber);
        const lidJid = normalizeBareJid((pObj as { lid?: string }).lid);
        const pnResolved =
          (pnJid && pnJid.endsWith('@s.whatsapp.net') ? pnJid : '') ||
          (rawJid && rawJid.endsWith('@s.whatsapp.net') ? rawJid : '');
        for (const u of [jidUserPart(rawJid), jidUserPart(pnJid), jidUserPart(lidJid)]) {
          if (u) {
            adminSet.add(u);
            if (pnResolved) priorAdminPnMap[u] = pnResolved;
          }
        }
      }
      knownGroupAdminsCache.set(groupId, adminSet);
      if (groupCfg.antiAdminKick) {
        vipStore.updateGroupConfig(groupId, {
          knownAdmins: Array.from(adminSet),
          knownAdminPns: priorAdminPnMap,
        });
      }
    }

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

    // 2b. Anti-Admin-Kick Guard (.antiadminkick):
    // If any admin (except the Bot itself) removes or demotes another admin,
    // immediately re-add + re-promote the kicked admin back to Admin (with privacy invite fallback)
    // and demote the offending non-creator admin.
    if ((update.action === 'remove' || update.action === 'demote') && groupCfg.antiAdminKick) {
      let protectedHandled = false;
      try {
        let meta;
        try {
          meta = await getCachedGroupMetadata(sock, groupId, true);
        } catch {
          await new Promise((r) => setTimeout(r, 500));
          meta = await getCachedGroupMetadata(sock, groupId, true);
        }
        const botJids = await getBotJids(sock);
        const botParticipant = findParticipant(meta.participants, botJids);

        if (!isParticipantAdmin(botParticipant)) {
          logger.warn(
            'antiAdminKick',
            `Event '${update.action}' in ${groupId} skipped: bot (${botJids[0] || 'unknown'}) is not Group Admin.`
          );
        } else {
          const actorCandidates = await expandActorKeys(sock, authorRaw, authorPnRaw);
          const actorParticipant = actorCandidates.length
            ? findParticipant(meta.participants, actorCandidates)
            : undefined;
          const actorParts = new Set(
            [
              ...actorCandidates.map((c) => jidUserPart(c)),
              jidUserPart(actorParticipant?.id),
              jidUserPart(actorParticipant?.lid),
              jidUserPart(actorParticipant?.phoneNumber),
            ].filter(Boolean)
          );

          const creatorParts = new Set(
            [
              jidUserPart(meta.owner),
              jidUserPart(meta.ownerPn),
              ...meta.participants
                .filter((p) => p.admin === 'superadmin')
                .flatMap((p) => [
                  jidUserPart(p.id),
                  jidUserPart(p.lid),
                  jidUserPart(p.phoneNumber),
                ]),
            ].filter(Boolean)
          );

          const actorIsBot = botJids.some((b) => actorParts.has(jidUserPart(b)));
          const actorIsCreator =
            actorParticipant?.admin === 'superadmin' ||
            Array.from(actorParts).some((u) => creatorParts.has(u));

          if (!actorIsBot) {
            interface KickedAdminTarget {
              rawJid: string;
              pnJid: string;
              userParts: string[];
            }
            const kickedAdminsToRestore: KickedAdminTarget[] = [];

            for (const participant of update.participants) {
              const pObj = typeof participant === 'string' ? { id: participant } : participant;
              const rawJid = normalizeBareJid(pObj.id);
              if (!rawJid) continue;
              const pnFromObj = normalizeBareJid((pObj as { phoneNumber?: string }).phoneNumber);
              const lidFromObj = normalizeBareJid((pObj as { lid?: string }).lid);
              const tUser = jidUserPart(rawJid);
              const tPn = jidUserPart(pnFromObj);
              const tLid = jidUserPart(lidFromObj);

              // Ignore voluntary self-leave (actor === target) or bot itself
              if (
                (tUser && actorParts.has(tUser)) ||
                (tPn && actorParts.has(tPn)) ||
                (tLid && actorParts.has(tLid))
              ) {
                continue;
              }
              if (
                botJids.some((b) => {
                  const bu = jidUserPart(b);
                  return Boolean(bu) && (bu === tUser || bu === tPn || bu === tLid);
                })
              ) {
                continue;
              }

              let resolvedPnJid =
                (pnFromObj && pnFromObj.endsWith('@s.whatsapp.net') ? pnFromObj : '') ||
                (rawJid.endsWith('@s.whatsapp.net') ? rawJid : '') ||
                priorAdminPnMap[tUser] ||
                priorAdminPnMap[tLid] ||
                '';

              if (!resolvedPnJid && isLidUser(rawJid) && sock.signalRepository?.lidMapping?.getPNForLID) {
                try {
                  const mapped = await sock.signalRepository.lidMapping.getPNForLID(rawJid);
                  if (mapped) resolvedPnJid = normalizeBareJid(mapped);
                } catch {
                  // Ignore unavailable LID mapping
                }
              }

              const priorMatch = priorMeta?.participants
                ? findParticipant(
                    priorMeta.participants,
                    [rawJid, pnFromObj, lidFromObj, resolvedPnJid].filter(Boolean)
                  )
                : undefined;

              if (!resolvedPnJid && priorMatch) {
                const matchPn = [priorMatch.phoneNumber, priorMatch.id]
                  .map((v) => normalizeBareJid(v))
                  .find((v) => v && v.endsWith('@s.whatsapp.net'));
                if (matchPn) resolvedPnJid = matchPn;
              }

              const mappedPnPart = jidUserPart(resolvedPnJid);
              const roleFromEvent = (pObj as { admin?: string | null }).admin;
              const wasAdmin =
                roleFromEvent === 'admin' ||
                roleFromEvent === 'superadmin' ||
                isParticipantAdmin(priorMatch) ||
                Boolean(tUser && priorAdminKeys.has(tUser)) ||
                Boolean(tPn && priorAdminKeys.has(tPn)) ||
                Boolean(tLid && priorAdminKeys.has(tLid)) ||
                Boolean(mappedPnPart && priorAdminKeys.has(mappedPnPart));

              if (wasAdmin) {
                const userParts = Array.from(
                  new Set([tUser, tPn, tLid, mappedPnPart].filter(Boolean))
                );
                kickedAdminsToRestore.push({
                  rawJid,
                  pnJid: resolvedPnJid,
                  userParts,
                });
              }
            }

            if (kickedAdminsToRestore.length > 0) {
              protectedHandled = true;
              const readdedTargets: KickedAdminTarget[] = [];
              const privacyFallbackTargets: KickedAdminTarget[] = [];

              if (update.action === 'remove') {
                for (const target of kickedAdminsToRestore) {
                  for (const part of target.userParts) {
                    restoredUserParts.add(part);
                  }
                  const addCandidates = Array.from(
                    new Set([target.pnJid, target.rawJid].filter(Boolean))
                  );
                  let added = false;
                  let privacyBlocked = false;

                  for (const jidCandidate of addCandidates) {
                    try {
                      const addRes = await sock.groupParticipantsUpdate(
                        groupId,
                        [jidCandidate],
                        'add'
                      );
                      const status = String(
                        (addRes?.[0] as { status?: string | number } | undefined)?.status ?? '200'
                      );
                      if (status === '200' || status === '201' || status === '409') {
                        added = true;
                        break;
                      }
                      if (status === '403' || status === '408') {
                        privacyBlocked = true;
                        break;
                      }
                      logger.warn(
                        'antiAdminKick',
                        `Add returned status ${status} for ${jidCandidate} in ${groupId}`
                      );
                    } catch (addErr) {
                      logger.warn(
                        'antiAdminKick',
                        `Add failed for ${jidCandidate} in ${groupId}: ${(addErr as Error).message}`
                      );
                    }
                  }

                  if (added) {
                    readdedTargets.push(target);
                  } else {
                    privacyFallbackTargets.push(target);
                    try {
                      const inviteCode = await sock.groupInviteCode(groupId);
                      if (inviteCode) {
                        const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
                        const dmCandidates = Array.from(
                          new Set([target.pnJid, target.rawJid].filter(Boolean))
                        );
                        for (const dmJid of dmCandidates) {
                          try {
                            await sock.sendMessage(dmJid, {
                              text: `🛡️ *Anti-Admin-Kick Shield*\nYou were removed from the group${privacyBlocked ? ' (direct re-add blocked by your group privacy settings)' : ''}.\nRejoin using this official group invite link:\n${inviteLink}`,
                            });
                            break;
                          } catch {
                            // Try alternate JID
                          }
                        }
                      }
                    } catch (inviteErr) {
                      logger.warn(
                        'antiAdminKick',
                        `Invite link fallback failed in ${groupId}: ${(inviteErr as Error).message}`
                      );
                    }
                  }
                }
              } else {
                // Action === 'demote' -> target is still in group, promote immediately
                readdedTargets.push(...kickedAdminsToRestore);
              }

              if (readdedTargets.length > 0) {
                if (update.action === 'remove') {
                  await new Promise((r) => setTimeout(r, 1200));
                }
                const freshMeta = await getCachedGroupMetadata(sock, groupId, true).catch(() => null);
                const resolvePromoteJids = (
                  targets: KickedAdminTarget[],
                  groupMeta: typeof freshMeta
                ) =>
                  targets.map((t) => {
                    if (groupMeta?.participants) {
                      const found = findParticipant(
                        groupMeta.participants,
                        [t.rawJid, t.pnJid, ...t.userParts.map((u) => `${u}@s.whatsapp.net`)].filter(Boolean)
                      );
                      if (found?.id) return found.id;
                    }
                    return t.rawJid || t.pnJid;
                  });

                const promoteJids = resolvePromoteJids(readdedTargets, freshMeta);
                try {
                  await sock.groupParticipantsUpdate(groupId, promoteJids, 'promote');
                } catch (promoteErr) {
                  logger.warn(
                    'antiAdminKick',
                    `Initial promote failed in ${groupId}: ${(promoteErr as Error).message}`
                  );
                }

                // Verify promotion after short settle delay and retry once if needed
                await new Promise((r) => setTimeout(r, 850));
                const verifyMeta = await getCachedGroupMetadata(sock, groupId, true).catch(() => null);
                if (verifyMeta?.participants) {
                  const stillNotAdmin = readdedTargets.filter((t) => {
                    const p = findParticipant(
                      verifyMeta.participants,
                      [t.rawJid, t.pnJid].filter(Boolean)
                    );
                    return Boolean(p && !isParticipantAdmin(p));
                  });
                  if (stillNotAdmin.length > 0) {
                    const retryJids = resolvePromoteJids(stillNotAdmin, verifyMeta);
                    await sock
                      .groupParticipantsUpdate(groupId, retryJids, 'promote')
                      .catch((retryErr) => {
                        logger.warn(
                          'antiAdminKick',
                          `Retry promote failed in ${groupId}: ${(retryErr as Error).message}`
                        );
                      });
                  }
                }
              }

              const actorTargetJid = actorParticipant?.id || actorCandidates[0] || authorRaw;
              let offendingDemoted = false;
              if (!actorIsCreator && actorTargetJid && isParticipantAdmin(actorParticipant)) {
                try {
                  await sock.groupParticipantsUpdate(groupId, [actorTargetJid], 'demote');
                  offendingDemoted = true;
                } catch (demoteErr) {
                  logger.warn(
                    'antiAdminKick',
                    `Failed to demote offending admin ${actorTargetJid} in ${groupId}: ${(demoteErr as Error).message}`
                  );
                }
              }

              invalidateGroupMetadataCache(groupId);
              const updatedAdminSet = new Set<string>(priorAdminKeys);
              if (offendingDemoted && actorTargetJid) {
                updatedAdminSet.delete(jidUserPart(actorTargetJid));
                if (actorParticipant?.phoneNumber) {
                  updatedAdminSet.delete(jidUserPart(actorParticipant.phoneNumber));
                }
              }
              for (const t of kickedAdminsToRestore) {
                for (const part of t.userParts) {
                  updatedAdminSet.add(part);
                  if (t.pnJid) priorAdminPnMap[part] = t.pnJid;
                }
              }
              knownGroupAdminsCache.set(groupId, updatedAdminSet);
              vipStore.updateGroupConfig(groupId, {
                knownAdmins: Array.from(updatedAdminSet),
                knownAdminPns: priorAdminPnMap,
              });

              const actorJid = actorTargetJid || '';
              const actorTag = actorJid ? `@${jidUserPart(actorJid)}` : 'An admin';
              const allTargets = kickedAdminsToRestore.map((t) => t.rawJid || t.pnJid).filter(Boolean);
              const targetTags = allTargets.map((t) => `@${jidUserPart(t)}`).join(', ');
              const mentions = Array.from(
                new Set([...allTargets, ...(actorJid ? [actorJid] : [])])
              );

              const statusLines: string[] = [];
              if (readdedTargets.length > 0) {
                statusLines.push(
                  update.action === 'remove'
                    ? `• Auto Re-Added & Restored as Admin: ${readdedTargets.map((t) => `@${jidUserPart(t.rawJid || t.pnJid)}`).join(', ')}`
                    : `• Restored as Admin: ${readdedTargets.map((t) => `@${jidUserPart(t.rawJid || t.pnJid)}`).join(', ')}`
                );
              }
              if (privacyFallbackTargets.length > 0) {
                statusLines.push(
                  `• Direct add blocked by privacy — Invite link sent via DM to: ${privacyFallbackTargets.map((t) => `@${jidUserPart(t.rawJid || t.pnJid)}`).join(', ')}`
                );
              }
              if (offendingDemoted && actorJid) {
                statusLines.push(`• Offending admin demoted: ${actorTag}`);
              }

              await sock
                .sendMessage(groupId, {
                  text:
                    update.action === 'remove'
                      ? `🛡️ *Anti-Admin-Kick Shield*\nAdmins cannot remove other admins here!\n• Unauthorized removal by: ${actorTag}\n${statusLines.join('\n')}`
                      : `🛡️ *Anti-Admin-Kick Shield*\nAdmins cannot demote other admins here!\n• Unauthorized demotion by: ${actorTag}\n${statusLines.join('\n')}`,
                  mentions,
                })
                .catch(() => {});
              logger.security(
                'antiAdminKick',
                `Restored admin(s) [${targetTags}] (readded=${readdedTargets.length}, privacyInvite=${privacyFallbackTargets.length}) after ${update.action} by ${actorJid || 'unknown'} in ${groupId}`
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          'antiAdminKick',
          `Anti-Admin-Kick check failed in ${groupId}: ${(err as Error).message}`
        );
      }

      // If this removal/demotion was authorized (bot itself) or antiAdminKick wasn't protecting a kicked admin,
      // refresh persisted admin list from live metadata so legitimate demotions/removals stay clean.
      if (!protectedHandled) {
        void syncGroupAdminSnapshot(sock, groupId, true);
      }
    } else if (update.action === 'remove' || update.action === 'demote') {
      const nextAdminSet = new Set<string>(priorAdminKeys);
      for (const participant of update.participants) {
        const pObj = typeof participant === 'string' ? { id: participant } : participant;
        nextAdminSet.delete(jidUserPart(pObj.id));
        nextAdminSet.delete(jidUserPart((pObj as { phoneNumber?: string }).phoneNumber));
        nextAdminSet.delete(jidUserPart((pObj as { lid?: string }).lid));
      }
      knownGroupAdminsCache.set(groupId, nextAdminSet);
      if (groupCfg.antiAdminKick) {
        vipStore.updateGroupConfig(groupId, { knownAdmins: Array.from(nextAdminSet) });
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
    if (
      (update.action === 'add' && (groupCfg.welcomeImg || groupCfg.welcome)) ||
      (update.action === 'remove' && groupCfg.goodbye)
    ) {
      cachedGroupMeta = await getCachedGroupMetadata(sock, groupId).catch(() => null);
    }

    const formatMemberTemplate = (
      template: string,
      mentionTag: string,
      groupSubject: string,
      totalCount: number
    ): string =>
      template
        .replace(/\{user\}/gi, mentionTag)
        .replace(/\{group\}/gi, groupSubject)
        .replace(/\{count\}/gi, String(totalCount));

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
      const mentionTag = mentionUser ? `@${mentionUser}` : num ? `@${num}` : 'Member';
      const groupName = cachedGroupMeta?.subject || 'WhatsApp Group';
      const memberCount = cachedGroupMeta?.participants?.length || 1;
      const customWelcomeTpl = (groupCfg.welcomeMessage || cfg.welcomeMessage || '').trim();
      const customGoodbyeTpl = (groupCfg.goodbyeMessage || cfg.goodbyeMessage || '').trim();

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

          const cardBuffer = await generateWelcomeImageCard({
            memberName,
            memberNumber: num || mentionUser,
            groupName,
            memberCount,
            avatarBuffer: avatarBuf,
            botName: cfg.botName || 'FADI KING MD',
          });

          const captionText = customWelcomeTpl
            ? formatMemberTemplate(customWelcomeTpl, mentionTag, groupName, memberCount)
            : `🎉 *Welcome @${mentionUser || num} to ${groupName}!*\n• Member #${memberCount}`;

          await sock
            .sendMessage(groupId, {
              image: cardBuffer,
              caption: captionText,
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
        const welcomeText = customWelcomeTpl
          ? formatMemberTemplate(customWelcomeTpl, mentionTag, groupName, memberCount)
          : `*_${mentionUser ? `@${mentionUser}` : 'Welcome'} joined the group, welcome!_* 🎉`;
        await sock
          .sendMessage(groupId, {
            text: welcomeText,
            mentions: [rawJid],
          })
          .catch(() => {});
      } else if (
        update.action === 'remove' &&
        groupCfg.goodbye &&
        !restoredUserParts.has(jidUserPart(rawJid)) &&
        !restoredUserParts.has(num)
      ) {
        const goodbyeText = customGoodbyeTpl
          ? formatMemberTemplate(customGoodbyeTpl, mentionTag, groupName, memberCount)
          : `*Goodbye @${mentionUser || num}*\nWishing you all the best ahead.`;
        await sock.sendMessage(groupId, {
          text: goodbyeText,
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

export function isStatusMentionPayload(msg: WAMessage, body: string): boolean {
  const inner = unwrapMessage(msg.message);
  const ctxInfo = extractContextInfo(msg.message) as
    | (Record<string, unknown> & { statusMentionMessageInfo?: unknown; statusMentions?: unknown[] })
    | undefined;
  const rawMsg = (msg.message || {}) as Record<string, unknown>;
  const msgCtx = rawMsg.messageContextInfo as
    | { statusMentionMessageInfo?: unknown; statusMentions?: unknown[] }
    | undefined;

  return Boolean(
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
}

export async function enforceGcStatusRemove(
  sock: WASocket,
  msg: WAMessage,
  body: string,
  chatId: string,
  senderCandidates: string[],
  isOwner: boolean
): Promise<boolean> {
  if (!chatId.endsWith('@g.us') || isOwner || msg.key?.fromMe) return false;
  const groupCfg = vipStore.getGroupConfig(chatId);
  if (!groupCfg.gcStatusRemove) return false;

  const hasLink = Boolean(body && (LINK_REGEX.test(body) || extractFirstUrl(body)));
  const hasStatusMention = isStatusMentionPayload(msg, body);
  if (!hasLink && !hasStatusMention) return false;

  try {
    let meta = await getCachedGroupMetadata(sock, chatId);
    recordKnownGroupAdmins(chatId, meta.participants || []);
    const senderParticipant = findParticipant(meta.participants, senderCandidates);
    if (isParticipantAdmin(senderParticipant)) return false;

    const botJids = await getBotJids(sock);
    let botParticipant = findParticipant(meta.participants, botJids);

    if (!isParticipantAdmin(botParticipant)) {
      meta = await getCachedGroupMetadata(sock, chatId, true);
      recordKnownGroupAdmins(chatId, meta.participants || []);
      botParticipant = findParticipant(meta.participants, botJids);
    }

    if (!isParticipantAdmin(botParticipant)) {
      logger.warn('gcStatusRemove', `Link/Status detected in ${chatId} but bot is not Group Admin.`);
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
    const gcStatusWarnings = { ...(groupCfg.gcStatusWarnings || {}) };
    const count = (gcStatusWarnings[warnKey] || 0) + 1;
    const violationLabel = hasStatusMention ? 'status/group status mention' : 'group/external link';

    if (count >= 3) {
      delete gcStatusWarnings[warnKey];
      vipStore.updateGroupConfig(chatId, { gcStatusWarnings });
      await sock.sendMessage(chatId, {
        text: `🚫 *GC Status/Link Warning 3/3 — Removed*\n@${senderDisplay} reached 3 warnings for sending a ${violationLabel} and has been automatically removed.`,
        mentions: [senderJid],
      });
      await sock.groupParticipantsUpdate(chatId, [senderJid], 'remove').catch(() => {});
      invalidateGroupMetadataCache(chatId);
      logger.security('gcStatusRemove', `Deleted ${violationLabel} & removed +${senderDisplay} after 3/3 warnings in ${chatId}`);
    } else {
      gcStatusWarnings[warnKey] = count;
      vipStore.updateGroupConfig(chatId, { gcStatusWarnings });
      await sock.sendMessage(chatId, {
        text: `⚠️ *GC Status/Link Warning ${count}/3*\n@${senderDisplay}, sending links or group status mentions is not allowed here. Message deleted (after 3 warnings you will be removed).`,
        mentions: [senderJid],
      });
      logger.security('gcStatusRemove', `Deleted ${violationLabel} & issued warning ${count}/3 to +${senderDisplay} in ${chatId}`);
    }
    return true;
  } catch (err) {
    logger.warn('gcStatusRemove', `GCstatusremove check failed: ${(err as Error).message}`);
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

  if (!isStatusMentionPayload(msg, body)) return false;

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

export async function dispatchOpenGcPayMessage(
  sock: WASocket,
  params: {
    finalText: string;
    linkUrl?: string;
    currency?: string;
    amount1000?: number;
    requestFrom?: string;
  }
): Promise<{ sent: number; totalOpen: number }> {
  const groupsMap = await sock.groupFetchAllParticipating();
  const openGroups = Object.values(groupsMap).filter((g) => !g.announce && !g.isCommunityAnnounce);
  if (openGroups.length === 0) {
    return { sent: 0, totalOpen: 0 };
  }

  let sent = 0;
  for (let i = 0; i < openGroups.length; i += 1) {
    const gc = openGroups[i];
    try {
      const res = await sendEncryptedPayMessage(sock, {
        chatId: gc.id,
        finalText: params.finalText,
        linkUrl: params.linkUrl,
        currency: params.currency,
        amount1000: params.amount1000,
        requestFrom: params.requestFrom,
      });
      sent += 1;
      if (res.keyId) {
        vipStore.registerProtectedPost(res.keyId, gc.id, res.finalText, 0, {
          currency: res.currency,
          amount1000: res.amount1000,
          finalText: res.finalText,
          linkUrl: res.linkUrl,
          requestFrom: res.requestFrom,
        });
      }
    } catch (err) {
      logger.warn('protectedPost', `Failed open-GC paymsg send to ${gc.id}: ${(err as Error).message}`);
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

function hasPaymentMessagePayload(message: WAMessage['message'] | undefined | null): boolean {
  const candidates = [message, unwrapMessage(message)];
  for (const m of candidates) {
    if (!m) continue;
    if (
      m.requestPaymentMessage ||
      m.sendPaymentMessage ||
      m.cancelPaymentRequestMessage ||
      m.declinePaymentRequestMessage ||
      m.paymentInviteMessage ||
      m.orderMessage ||
      m.invoiceMessage
    ) {
      return true;
    }
    const buttons = m.interactiveMessage?.nativeFlowMessage?.buttons;
    if (
      Array.isArray(buttons) &&
      buttons.some((b) =>
        ['payment_info', 'order_details', 'pay_now', 'send_payment', 'review_and_pay'].includes(
          String(b?.name || '').toLowerCase()
        )
      )
    ) {
      return true;
    }
  }
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
    Boolean(groupCfg.antiSticker) ||
    Boolean(groupCfg.antiPayMsg);

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

    // 2b. Anti-PayMsg Check (requestPaymentMessage, sendPaymentMessage, paymentInvite, order, invoice)
    if (groupCfg.antiPayMsg && hasPaymentMessagePayload(msg.message)) {
      if (!botIsAdmin) return false;
      await deleteCurrentMsg();
      logger.security('antiPayMsg', `Deleted payment message from +${senderKey} in ${chatId}`);
      if (canSendGuardNotice(`pay:${chatId}:${senderKey}`)) {
        await sock
          .sendMessage(chatId, {
            text: `*Anti-PayMsg Guard*\n@${senderKey}, payment, order, and invoice messages are not allowed in this group.`,
            mentions: [senderJid],
          })
          .catch(() => {});
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
