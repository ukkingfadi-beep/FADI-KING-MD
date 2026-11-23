import QRCode from 'qrcode';
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { isValidPhone, loadConfig, normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  extractContextInfo,
  extractRawTargetCandidates,
  getBotJids,
  getCachedGroupMetadata,
  hasValidMediaPayload,
  isLidUser,
  jidUserPart,
  lookupKnownUserName,
  normalizeBareJid,
  participantMatchesAny,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import {
  applyBassBoostEffect,
  clearSocketPlaceholderCacheEntry,
  convertAudioPartsToWhatsAppVoice,
  convertMediaToWebpSticker,
  convertStickerToPng,
  detectMediaType,
  downloadMessageMedia,
  extractBinaryBuffer,
  extractQuotedMessage,
  getCachedViewOnceMedia,
  getCachedViewOnceMeta,
  getUnavailableViewOnceRecord,
  inspectWebpStickerBuffer,
  isFfmpegAvailable,
  sendImmediateViewOncePdo,
  synthesizeTtsVoiceNote,
  unwrapViewOnce,
  waitForViewOnceInflight,
} from '../utils/mediaHelper.ts';
import {
  extractStatusMediaPayload,
  findStatusesForUser,
  getOrDownloadStatusBuffer,
  getStatusById,
  listActiveStatusPosters,
  type CachedStatusEntry,
} from '../utils/statusStore.ts';
import { getRecentChatMessages } from '../utils/chatHistoryStore.ts';
import {
  generateBioOptionsReply,
  generateFactCheckReply,
  generateGrammarCorrection,
  generateGroupSummary,
  generatePlayfulRoast,
  generatePoetryReply,
  isGeminiConfigured,
} from '../utils/geminiService.ts';
import {
  downloadSocialMedia,
  extractFirstValidUrl,
  type SocialPlatform,
} from '../utils/socialDownloader.ts';
import { vipStore } from '../utils/vipStore.ts';
import type { BotCommand, CommandContext } from './types.ts';

function evaluateSafeMath(expr: string): number {
  const clean = expr.replace(/\s+/g, '');
  if (!/^[0-9+\-*/().%^]+$/.test(clean) || clean.length > 80) {
    throw new Error('Only numbers and +, -, *, /, %, ^, ( ) operators are allowed.');
  }
  let pos = 0;
  function peek(): string {
    return clean[pos] || '';
  }
  function parseExpr(): number {
    let val = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = clean[pos++];
      const rhs = parseTerm();
      val = op === '+' ? val + rhs : val - rhs;
    }
    return val;
  }
  function parseTerm(): number {
    let val = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = clean[pos++];
      const rhs = parsePower();
      if ((op === '/' || op === '%') && rhs === 0) throw new Error('Division by zero');
      val = op === '*' ? val * rhs : op === '/' ? val / rhs : val % rhs;
    }
    return val;
  }
  function parsePower(): number {
    const base = parseFactor();
    if (peek() === '^') {
      pos++;
      return Math.pow(base, parsePower());
    }
    return base;
  }
  function parseFactor(): number {
    if (peek() === '+' || peek() === '-') {
      const sign = clean[pos++] === '-' ? -1 : 1;
      return sign * parseFactor();
    }
    if (peek() === '(') {
      pos++;
      const inner = parseExpr();
      if (clean[pos] !== ')') throw new Error('Mismatched parentheses');
      pos++;
      return inner;
    }
    const start = pos;
    while (/[0-9.]/.test(peek())) pos++;
    if (start === pos) throw new Error('Invalid expression');
    const num = Number(clean.slice(start, pos));
    if (!Number.isFinite(num)) throw new Error('Invalid number');
    return num;
  }
  const result = parseExpr();
  if (pos !== clean.length || !Number.isFinite(result)) {
    throw new Error('Invalid math expression');
  }
  return result;
}

const VIP_QUOTES = [
  'Kamyabi unhi ko milti hai jo waqt aur sabar dono ke sath mehnat karte hain.',
  'Discipline beats motivation when your goals are bigger than your excuses.',
  'Chup reh kar apni mehnat itni tez karo ke kamyabi khud shor machaye.',
  'Stay consistent, stay humble, and let your work speak louder than promises.',
  'Har mushkil waqt sirf is liye aata hai taake aap aur zyada mazboot ban sako.',
  'Protect your peace, focus on your craft, and never settle for average.',
];

export const mediaCommands: BotCommand[] = [
  {
    name: 's',
    aliases: ['sticker', 'stiker'],
    category: 'media',
    description: 'Photo, video ya GIF par reply karke WhatsApp sticker banaye',
    usage: 's (reply or attach photo/video/GIF)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to a photo, video, or GIF on WhatsApp with `.s` to convert it into a sticker.';
        await ctx.reply(msg);
        return msg;
      }

      const quoted = extractQuotedMessage(ctx.msg);
      const targetMsgContent = quoted || unwrapMessage(ctx.msg.message) || ctx.msg.message;
      const mediaType = detectMediaType(targetMsgContent);

      if (mediaType !== 'image' && mediaType !== 'video') {
        const msg = `Please send or reply to a photo, video, or GIF with \`${ctx.prefix}s\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(targetMsgContent)) {
        const msg = 'Media payload unavailable or expired. Resend the photo/video/GIF and reply with `.s`.';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const fakeInfo: WAMessage = {
          key: ctx.msg.key,
          message: targetMsgContent,
        };
        const rawBuffer = await downloadMessageMedia(ctx.sock, fakeInfo);
        const webpBuffer = await convertMediaToWebpSticker(rawBuffer, mediaType === 'video');

        await ctx.sock.sendMessage(
          ctx.chatId,
          { sticker: webpBuffer },
          { quoted: ctx.msg }
        );
        return 'Sticker generated and sent.';
      } catch (err) {
        const msg = `Sticker failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'toimg',
    aliases: ['toimage'],
    category: 'media',
    description: 'Sticker ko normal image (PNG) mein convert kare',
    usage: 'toimg (reply to sticker)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to a WhatsApp sticker with `.toimg` to convert it back to a PNG image.';
        await ctx.reply(msg);
        return msg;
      }

      const quoted = extractQuotedMessage(ctx.msg);
      if (detectMediaType(quoted) !== 'sticker') {
        const msg = `Reply to a sticker using \`${ctx.prefix}toimg\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(quoted)) {
        const msg = 'Sticker media data unavailable. Resend the sticker and reply with `.toimg`.';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const fakeInfo: WAMessage = {
          key: ctx.msg.key,
          message: quoted,
        };
        const stickerBuf = await downloadMessageMedia(ctx.sock, fakeInfo);
        const pngBuffer = await convertStickerToPng(stickerBuf);

        await ctx.sock.sendMessage(
          ctx.chatId,
          { image: pngBuffer, caption: `Converted by ${loadConfig().botName}` },
          { quoted: ctx.msg }
        );
        return 'Sticker converted to image.';
      } catch (err) {
        const msg = `Convert failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'vv',
    aliases: ['viewonce', 'rvo'],
    category: 'media',
    description: 'View-once photo, video ya voice note ko normal viewable media mein extract kare',
    usage: 'vv (reply to view-once photo/video/voice)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to a View-Once photo, video, or voice note on WhatsApp with `.vv` to unwrap it.';
        await ctx.reply(msg);
        return msg;
      }

      const sendRecoveredMedia = async (params: {
        type: 'image' | 'video' | 'audio';
        buffer: Buffer;
        caption?: string;
        mimetype?: string;
        ptt?: boolean;
        seconds?: number;
      }) => {
        if (!params.buffer || params.buffer.length === 0) {
          throw new Error('Recovered View-Once media buffer was empty.');
        }
        const cfg = loadConfig();
        if (params.type === 'image') {
          await ctx.sock!.sendMessage(
            ctx.chatId,
            {
              image: params.buffer,
              mimetype: params.mimetype || 'image/jpeg',
              caption: params.caption || `👁️ View-Once Photo extracted by ${cfg.botName}`,
            },
            { quoted: ctx.msg! }
          );
          return;
        }
        if (params.type === 'video') {
          await ctx.sock!.sendMessage(
            ctx.chatId,
            {
              video: params.buffer,
              mimetype: params.mimetype || 'video/mp4',
              caption: params.caption || `👁️ View-Once Video extracted by ${cfg.botName}`,
            },
            { quoted: ctx.msg! }
          );
          return;
        }

        const mime = (params.mimetype || '').toLowerCase();
        const isOggOpus = mime.includes('ogg') || mime.includes('opus');
        if (!isOggOpus && (await isFfmpegAvailable())) {
          try {
            const inputExt: 'mp3' | 'wav' = mime.includes('wav') ? 'wav' : 'mp3';
            const converted = await convertAudioPartsToWhatsAppVoice([params.buffer], inputExt);
            await ctx.sock!.sendMessage(
              ctx.chatId,
              {
                audio: converted.buffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
                seconds: converted.seconds,
              },
              { quoted: ctx.msg! }
            );
            return;
          } catch {
            // Fall through to raw audio buffer send below
          }
        }

        await ctx.sock!.sendMessage(
          ctx.chatId,
          {
            audio: params.buffer,
            mimetype: params.mimetype || 'audio/ogg; codecs=opus',
            ptt: params.ptt ?? true,
            seconds: params.seconds,
          },
          { quoted: ctx.msg! }
        );
      };

      const ctxInfo = extractContextInfo(ctx.msg.message);
      const stanzaId = ctxInfo?.stanzaId || '';
      const cacheLookupId = stanzaId || ctx.msg.key?.id || '';

      // 1. Check pre-cached View-Once media buffer first (RAM + disk cache, survives restarts)
      if (cacheLookupId) {
        await waitForViewOnceInflight(cacheLookupId);
        const preCached = getCachedViewOnceMedia(ctx.chatId, cacheLookupId);
        if (preCached && preCached.buffer.length > 0) {
          await sendRecoveredMedia(preCached);
          return 'View-Once media unwrapped.';
        }
      }

      const rawQuoted = ctxInfo?.quotedMessage || null;
      const quoted = extractQuotedMessage(ctx.msg);
      let inner =
        unwrapViewOnce(rawQuoted) ||
        unwrapViewOnce(quoted) ||
        unwrapViewOnce(ctx.msg.message) ||
        quoted ||
        rawQuoted;

      const botJids = await getBotJids(ctx.sock);
      const botUserParts = new Set(botJids.map((b) => jidUserPart(b)).filter(Boolean));
      let quotedParticipant = ctxInfo?.participant || undefined;

      // Resolve quotedParticipant LID -> PN too for accurate fromMe detection
      let quotedParticipantAlt: string | undefined;
      if (
        quotedParticipant &&
        isLidUser(quotedParticipant) &&
        ctx.sock.signalRepository?.lidMapping?.getPNForLID
      ) {
        try {
          const pn = await ctx.sock.signalRepository.lidMapping.getPNForLID(
            normalizeBareJid(quotedParticipant)
          );
          if (pn) quotedParticipantAlt = normalizeBareJid(pn);
        } catch {
          // Ignore LID lookup errors
        }
      }

      const unavailRecord = stanzaId ? getUnavailableViewOnceRecord(stanzaId) : undefined;
      const isSelfChat =
        !ctx.isGroup &&
        (botUserParts.has(jidUserPart(ctx.chatId)) ||
          Boolean(ctx.msg.key?.remoteJidAlt && botUserParts.has(jidUserPart(ctx.msg.key.remoteJidAlt))));

      const quotedFromBot = Boolean(
        unavailRecord?.cleanKey.fromMe ||
          (quotedParticipant && botUserParts.has(jidUserPart(quotedParticipant))) ||
          (quotedParticipantAlt && botUserParts.has(jidUserPart(quotedParticipantAlt))) ||
          (!quotedParticipant && isSelfChat && ctx.msg.key?.fromMe)
      );

      let sourceKey: WAMessageKey = stanzaId
        ? unavailRecord?.cleanKey || {
            remoteJid: ctx.chatId,
            fromMe: quotedFromBot,
            id: stanzaId,
            ...(quotedParticipant ? { participant: quotedParticipant } : {}),
          }
        : ctx.msg.key;

      // 2. Fallback to cached original WAMessage (RAM + remoteJidAlt + disk metadata)
      const remoteJidAlt = ctx.msg.key?.remoteJidAlt;
      const lookupCachedInner = () => {
        if (!stanzaId) return null;
        if (ctx.getCachedMessage) {
          const ramLookups = [
            ctx.getCachedMessage(ctx.chatId, stanzaId),
            remoteJidAlt ? ctx.getCachedMessage(remoteJidAlt, stanzaId) : undefined,
            ctxInfo?.remoteJid ? ctx.getCachedMessage(ctxInfo.remoteJid, stanzaId) : undefined,
          ];
          for (const cachedOrig of ramLookups) {
            if (cachedOrig?.message) {
              const cachedInner =
                unwrapViewOnce(cachedOrig.message) || unwrapMessage(cachedOrig.message);
              if (cachedInner && hasValidMediaPayload(cachedInner)) {
                return { inner: cachedInner, key: cachedOrig.key || sourceKey };
              }
            }
          }
        }
        const diskMeta = getCachedViewOnceMeta(stanzaId);
        if (diskMeta?.message && hasValidMediaPayload(diskMeta.message)) {
          return { inner: diskMeta.message, key: diskMeta.key || sourceKey };
        }
        return null;
      };

      if ((!inner || !hasValidMediaPayload(inner)) && stanzaId) {
        const hit = lookupCachedInner();
        if (hit) {
          inner = hit.inner;
          sourceKey = hit.key;
        }
      }

      // 3. On-demand instant PDO placeholder resend request across PN/LID key variants
      if (
        stanzaId &&
        (!inner || !hasValidMediaPayload(unwrapViewOnce(inner) || unwrapMessage(inner) || inner)) &&
        (typeof ctx.sock.sendPeerDataOperationMessage === 'function' ||
          typeof ctx.sock.requestPlaceholderResend === 'function')
      ) {
        const pdoCandidates: WAMessageKey[] = [];
        const seenPdo = new Set<string>();
        const pushPdoKey = (k: WAMessageKey | undefined) => {
          if (!k?.id || !k?.remoteJid) return;
          const sig = `${k.remoteJid}|${Boolean(k.fromMe)}|${k.participant || ''}`;
          if (seenPdo.has(sig)) return;
          seenPdo.add(sig);
          pdoCandidates.push(k);
        };

        pushPdoKey(unavailRecord?.cleanKey);
        for (const alt of unavailRecord?.altKeys || []) {
          pushPdoKey(alt);
        }
        pushPdoKey({
          remoteJid: ctx.chatId,
          fromMe: quotedFromBot,
          id: stanzaId,
          ...(quotedParticipant ? { participant: quotedParticipant } : {}),
        });
        if (remoteJidAlt) {
          pushPdoKey({
            remoteJid: remoteJidAlt,
            fromMe: quotedFromBot,
            id: stanzaId,
            ...(quotedParticipantAlt
              ? { participant: quotedParticipantAlt }
              : quotedParticipant
                ? { participant: quotedParticipant }
                : {}),
          });
        }
        if (!ctx.isGroup) {
          pushPdoKey({
            remoteJid: ctx.chatId,
            fromMe: !quotedFromBot,
            id: stanzaId,
          });
          if (remoteJidAlt) {
            pushPdoKey({
              remoteJid: remoteJidAlt,
              fromMe: !quotedFromBot,
              id: stanzaId,
            });
          }
        }

        if (pdoCandidates.length > 0) {
          await clearSocketPlaceholderCacheEntry(ctx.sock, stanzaId);
          await sendImmediateViewOncePdo(ctx.sock, pdoCandidates);
        }

        let triedBackupPdo = false;
        for (let attempt = 0; attempt < 22; attempt += 1) {
          await new Promise((r) => setTimeout(r, 250));
          await waitForViewOnceInflight(stanzaId);
          const preCachedAfterPdo = getCachedViewOnceMedia(ctx.chatId, stanzaId);
          if (preCachedAfterPdo && preCachedAfterPdo.buffer.length > 0) {
            await sendRecoveredMedia(preCachedAfterPdo);
            return 'View-Once media unwrapped.';
          }
          const hit = lookupCachedInner();
          if (hit) {
            inner = hit.inner;
            sourceKey = hit.key;
            break;
          }
          if (!triedBackupPdo && attempt === 8 && pdoCandidates.length > 0) {
            triedBackupPdo = true;
            await clearSocketPlaceholderCacheEntry(ctx.sock, stanzaId);
            if (typeof ctx.sock.requestPlaceholderResend === 'function') {
              try {
                await ctx.sock.requestPlaceholderResend(pdoCandidates[0]);
              } catch {
                // Ignore PDO fallback error
              }
            } else {
              await sendImmediateViewOncePdo(ctx.sock, pdoCandidates);
            }
          }
        }
      }

      if (!inner) {
        const msg = `Reply to a View-Once photo, video, or voice note with \`${ctx.prefix}vv\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const unwrappedInner = unwrapViewOnce(inner) || unwrapMessage(inner) || inner;
      const type = detectMediaType(unwrappedInner);
      if (type !== 'image' && type !== 'video' && type !== 'audio') {
        const msg = 'No View-Once image, video, or voice note detected in the quoted message.';
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(unwrappedInner)) {
        const thumbBuf = extractBinaryBuffer(
          unwrappedInner.imageMessage?.jpegThumbnail ||
            unwrappedInner.videoMessage?.jpegThumbnail ||
            unwrappedInner.ptvMessage?.jpegThumbnail
        );
        if (thumbBuf && thumbBuf.length >= 150) {
          await sendRecoveredMedia({
            type: 'image',
            buffer: thumbBuf,
            mimetype: 'image/jpeg',
            caption:
              '⚠️ View-Once preview recovered (WhatsApp withheld the full HD decryption key from linked Web sessions).',
          });
          return 'View-Once preview recovered.';
        }

        const msg = unavailRecord
          ? 'WhatsApp withheld this View-Once photo/media key from linked Web sessions (`view_once_unavailable_fanout`) and the primary phone did not resend it.'
          : 'This View-Once media key was stripped or expired before arrival (not recoverable on linked Web sessions).';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const targetInfo: WAMessage = {
          key: sourceKey,
          message: unwrappedInner,
        };
        const buffer = await downloadMessageMedia(ctx.sock, targetInfo);

        await sendRecoveredMedia({
          type,
          buffer,
          caption: unwrappedInner.imageMessage?.caption || unwrappedInner.videoMessage?.caption || undefined,
          mimetype:
            unwrappedInner.audioMessage?.mimetype ||
            unwrappedInner.videoMessage?.mimetype ||
            unwrappedInner.ptvMessage?.mimetype ||
            unwrappedInner.imageMessage?.mimetype ||
            undefined,
          ptt: unwrappedInner.audioMessage ? unwrappedInner.audioMessage.ptt !== false : undefined,
          seconds:
            unwrappedInner.audioMessage?.seconds ||
            unwrappedInner.videoMessage?.seconds ||
            unwrappedInner.ptvMessage?.seconds ||
            undefined,
        });
        return 'View-Once media unwrapped.';
      } catch (err) {
        const msg = `View-Once download failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'info',
    aliases: ['userinfo', 'whois'],
    category: 'media',
    description: 'User aur current chat ki basic details show kare',
    usage: 'info [@user]',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const vip = vipStore.findVip(ctx.senderNumber);
      const role = ctx.isOwner ? 'Owner' : vip ? `VIP (${vip.tier.toUpperCase()})` : 'Standard User';
      let bio = 'Unavailable';

      if (ctx.sock && !ctx.isSimulated) {
        try {
          const statusRes = await ctx.sock.fetchStatus(ctx.senderJid);
          const statusText = Array.isArray(statusRes)
            ? (statusRes[0] as { status?: string })?.status
            : (statusRes as { status?: string } | undefined)?.status;
          if (statusText) bio = statusText;
        } catch {
          // Privacy settings may hide bio
        }
      }

      const lines = [
        `*${loadConfig().botName} — User & Chat Info*`,
        `• Name: ${ctx.pushName}`,
        `• Number: +${ctx.senderNumber}`,
        `• JID: \`${ctx.senderJid}\``,
        `• Access Role: ${role}`,
        `• Chat Type: ${ctx.isGroup ? 'Group Chat' : 'Private DM'}`,
        `• Bio: ${bio}`,
      ];
      const msg = lines.join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'del',
    aliases: ['delete'],
    category: 'media',
    description: 'Replied message ko chat/group se delete kare',
    usage: 'del (reply to message)',
    cooldownSeconds: 1,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to a message on WhatsApp with `.del` to delete it.';
        await ctx.reply(msg);
        return msg;
      }
      const ctxInfo = extractContextInfo(ctx.msg.message);
      if (!ctxInfo?.stanzaId) {
        const msg = `Reply to the message you want to delete with \`${ctx.prefix}del\`.`;
        await ctx.reply(msg);
        return msg;
      }
      await ctx.sock.sendMessage(ctx.chatId, {
        delete: {
          remoteJid: ctx.chatId,
          fromMe: Boolean(ctxInfo.participant === ctx.sock.user?.id),
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant || undefined,
        },
      });
      return 'Message deleted.';
    },
  },
  {
    name: 'tts',
    aliases: ['voice', 'speak', 'sayvoice'],
    category: 'media',
    description: 'Likhe hue text ya replied message ko voice note mein convert kare',
    usage: 'tts [lang] <text> (or reply to message)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';

      let langHint: string | undefined;
      let textToSpeak = ctx.text.trim();

      const firstArg = ctx.args[0]?.toLowerCase() || '';
      if (/^[a-z]{2}(-[a-z]{2})?$/.test(firstArg) && ctx.args.length >= 2) {
        langHint = firstArg;
        textToSpeak = ctx.args.slice(1).join(' ').trim();
      } else if (/^[a-z]{2}(-[a-z]{2})?$/.test(firstArg) && !ctx.args[1] && quotedText) {
        langHint = firstArg;
        textToSpeak = quotedText;
      }

      if (!textToSpeak) {
        textToSpeak = quotedText;
      }

      if (!textToSpeak) {
        const msg = `Usage: \`${ctx.prefix}tts Assalamualaikum everyone\` or \`${ctx.prefix}tts ur Salam\` (or reply to any text message).`;
        await ctx.reply(msg);
        return msg;
      }

      if (!ctx.sock || ctx.isSimulated) {
        const lang = langHint || (/[\u0600-\u06FF]/.test(textToSpeak) ? 'ur' : 'en');
        const msg = `[Simulated TTS Voice Note (${lang})]: "${textToSpeak.slice(0, 120)}"`;
        await ctx.reply(msg);
        return msg;
      }

      try {
        const voice = await synthesizeTtsVoiceNote(textToSpeak, langHint);
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            audio: voice.buffer,
            mimetype: voice.mimetype,
            ptt: voice.ptt,
            ...(typeof voice.seconds === 'number' ? { seconds: voice.seconds } : {}),
            ...(voice.waveform ? { waveform: voice.waveform } : {}),
          },
          ctx.msg ? { quoted: ctx.msg } : undefined
        );
        return `TTS voice note sent (${voice.lang}, ${voice.seconds || 1}s).`;
      } catch (err) {
        const msg = `TTS failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'savestatus',
    aliases: ['statusdl', 'getstatus'],
    category: 'media',
    description:
      'Kisi ko bhi mention/number/reply karke uska WhatsApp Status media (photo/video/audio) isi chat aur aapke inbox (IB) mein save kare',
    usage: 'savestatus [@user | number | reply] [all]',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg =
          'Mention `@user`, pass a phone number, or reply to a WhatsApp Status/message with `.savestatus` to save their status media in both this chat and your IB.';
        await ctx.reply(msg);
        return msg;
      }

      const sock = ctx.sock;
      const incomingMsg = ctx.msg;
      const ctxInfo = extractContextInfo(incomingMsg.message);
      const stanzaId = ctxInfo?.stanzaId || '';
      const quoted = extractQuotedMessage(incomingMsg);

      const ownBotPhone = normalizePhone(jidUserPart(sock.user?.id));
      const targetDm =
        incomingMsg.key?.fromMe && ownBotPhone
          ? `${ownBotPhone}@s.whatsapp.net`
          : isValidPhone(ctx.senderNumber)
            ? `${ctx.senderNumber}@s.whatsapp.net`
            : normalizeBareJid(ctx.senderJid);

      const sameAsCurrentChat =
        Boolean(targetDm) &&
        (normalizeBareJid(targetDm) === normalizeBareJid(ctx.chatId) ||
          (Boolean(jidUserPart(targetDm)) && jidUserPart(targetDm) === jidUserPart(ctx.chatId)));

      const resolveVerifiedPhone = async (jids: string[], fallbackPhone: string): Promise<string> => {
        if (isValidPhone(fallbackPhone)) return fallbackPhone;
        for (const jid of jids) {
          if (jid.endsWith('@s.whatsapp.net')) {
            const p = normalizePhone(jidUserPart(jid));
            if (isValidPhone(p)) return p;
          }
        }
        for (const jid of jids) {
          if (isLidUser(jid) && sock.signalRepository?.lidMapping?.getPNForLID) {
            try {
              const pn = await sock.signalRepository.lidMapping.getPNForLID(normalizeBareJid(jid));
              const p = normalizePhone(jidUserPart(pn));
              if (isValidPhone(p)) return p;
            } catch {
              // Ignore LID mapping miss
            }
          }
        }
        if (ctx.isGroup && jids.length > 0) {
          try {
            const meta = await getCachedGroupMetadata(sock, ctx.chatId);
            for (const participant of meta.participants) {
              if (participantMatchesAny(participant, jids)) {
                const candidate = participant.phoneNumber || (participant.id?.endsWith('@s.whatsapp.net') ? participant.id : '');
                const p = normalizePhone(jidUserPart(candidate));
                if (isValidPhone(p)) return p;
              }
            }
          } catch {
            // Ignore group metadata lookup error
          }
        }
        return '';
      };

      const deliverStatusToBoth = async (
        entry: CachedStatusEntry,
        footerNote?: string
      ): Promise<void> => {
        const buf = await getOrDownloadStatusBuffer(sock, entry);
        if (!buf || buf.length === 0) {
          throw new Error('Status media download or decryption failed (payload may have expired).');
        }

        const verifiedPhone = await resolveVerifiedPhone(entry.senderJids, entry.senderPhone);
        const header = `*Saved Status* (${entry.pushName}${verifiedPhone && !entry.pushName.includes(verifiedPhone) ? ` • +${verifiedPhone}` : ''})`;
        const noteSuffix = footerNote ? `\n_${footerNote}_` : '';
        const caption = [header, entry.caption ? `\n${entry.caption}` : '', noteSuffix]
          .filter(Boolean)
          .join('')
          .trim();

        if (entry.mediaType === 'image') {
          await sock.sendMessage(
            ctx.chatId,
            { image: buf, mimetype: entry.mimetype || 'image/jpeg', caption },
            { quoted: incomingMsg }
          );
          if (!sameAsCurrentChat && targetDm) {
            await sock.sendMessage(targetDm, {
              image: buf,
              mimetype: entry.mimetype || 'image/jpeg',
              caption,
            });
          }
          return;
        }

        if (entry.mediaType === 'video') {
          await sock.sendMessage(
            ctx.chatId,
            { video: buf, mimetype: entry.mimetype || 'video/mp4', caption },
            { quoted: incomingMsg }
          );
          if (!sameAsCurrentChat && targetDm) {
            await sock.sendMessage(targetDm, {
              video: buf,
              mimetype: entry.mimetype || 'video/mp4',
              caption,
            });
          }
          return;
        }

        // Audio / voice status: always send the downloaded audio buffer + sender/caption details
        await sock.sendMessage(
          ctx.chatId,
          {
            audio: buf,
            mimetype: entry.mimetype || 'audio/mp4',
            ptt: entry.ptt ?? false,
            seconds: entry.seconds,
          },
          { quoted: incomingMsg }
        );
        if (caption) {
          await sock.sendMessage(ctx.chatId, { text: caption }, { quoted: incomingMsg });
        }
        if (!sameAsCurrentChat && targetDm) {
          await sock.sendMessage(targetDm, {
            audio: buf,
            mimetype: entry.mimetype || 'audio/mp4',
            ptt: entry.ptt ?? false,
            seconds: entry.seconds,
          });
          if (caption) {
            await sock.sendMessage(targetDm, { text: caption });
          }
        }
      };

      // Mode A: Direct reply to a status@broadcast message (or cached status ID)
      const isDirectStatusReply = Boolean(
        stanzaId &&
          (ctxInfo?.remoteJid === 'status@broadcast' ||
            getStatusById(stanzaId) ||
            ctx.getCachedMessage?.('status@broadcast', stanzaId))
      );

      if (isDirectStatusReply) {
        const storeHit = getStatusById(stanzaId);
        if (storeHit) {
          try {
            await deliverStatusToBoth(storeHit);
            return sameAsCurrentChat
              ? 'Status media saved in this chat.'
              : 'Status media saved in this chat and sent to your IB.';
          } catch (err) {
            const msg = `Save status failed: ${(err as Error).message}`;
            await ctx.reply(msg);
            return msg;
          }
        }

        const cachedBroadcast = ctx.getCachedMessage?.('status@broadcast', stanzaId);
        const sourceMsg = cachedBroadcast?.message || quoted || ctxInfo?.quotedMessage;
        const extracted = extractStatusMediaPayload(sourceMsg);

        if (!extracted) {
          logger.info('savestatus', `Ignored text-only or non-media status reply (${stanzaId}).`);
          const msg =
            'Text-only statuses are ignored — only WhatsApp status photos, videos, and audio statuses can be downloaded.';
          await ctx.reply(msg);
          return msg;
        }

        if (!hasValidMediaPayload(extracted.inner)) {
          logger.info(
            'savestatus',
            `Ignored ${extracted.isViewOnce ? 'unsupported view-once' : 'incomplete'} status media (${stanzaId}).`
          );
          const msg = extracted.isViewOnce
            ? 'Unsupported View-Once status media cannot be decrypted from this reply.'
            : 'Status media key is missing or expired. Ask the contact to repost or view the status while the bot is online.';
          await ctx.reply(msg);
          return msg;
        }

        const participantBare = ctxInfo?.participant ? normalizeBareJid(ctxInfo.participant) : '';
        const senderJids = participantBare ? [participantBare] : [];
        const verifiedPhone = await resolveVerifiedPhone(senderJids, '');
        const pushName =
          lookupKnownUserName(ctxInfo?.participant) ||
          (verifiedPhone ? `+${verifiedPhone}` : 'Contact');

        const syntheticEntry: CachedStatusEntry = {
          id: stanzaId,
          msg: cachedBroadcast
            ? { key: cachedBroadcast.key, message: extracted.inner }
            : { key: incomingMsg.key, message: extracted.inner },
          inner: extracted.inner,
          mediaType: extracted.mediaType,
          caption: extracted.caption,
          mimetype: extracted.mimetype,
          ptt: extracted.ptt,
          seconds: extracted.seconds,
          senderJids,
          senderPhone: verifiedPhone,
          pushName,
          timestampMs: Date.now(),
        };

        try {
          await deliverStatusToBoth(syntheticEntry);
          return sameAsCurrentChat
            ? 'Status media saved in this chat.'
            : 'Status media saved in this chat and sent to your IB.';
        } catch (err) {
          const msg = `Save status failed: ${(err as Error).message}`;
          await ctx.reply(msg);
          return msg;
        }
      }

      // Mode B: Target user via @mention, phone number, replied message's sender, or 1-on-1 DM peer
      const wantAll = ctx.args.some((a) => a.toLowerCase() === 'all');
      const cleanedArgs = ctx.args.filter((a) => a.toLowerCase() !== 'all');
      const rawTargets = extractRawTargetCandidates(incomingMsg, cleanedArgs);

      if (rawTargets.length === 0 && !ctx.isGroup) {
        const peer = incomingMsg.key?.remoteJidAlt || ctx.chatId;
        if (peer) rawTargets.push(normalizeBareJid(peer));
      }

      if (rawTargets.length === 0) {
        const posters = listActiveStatusPosters(5);
        const activeHint =
          posters.length > 0
            ? `\n\n*Recent cached media status posters:*\n${posters
                .map((p) =>
                  p.phone
                    ? `• ${p.pushName} (+${p.phone}) — ${p.count} status(es)`
                    : `• ${p.pushName} — ${p.count} status(es)`
                )
                .join('\n')}`
            : '';
        const msg = `Mention someone, pass a phone number, or reply to a status/message.\nUsage: \`${ctx.prefix}savestatus @user\` or \`${ctx.prefix}savestatus 923001234567\`${activeHint}`;
        await ctx.reply(msg);
        return msg;
      }

      const resolvedCandidates = new Set<string>(rawTargets);
      for (const raw of rawTargets) {
        const bare = normalizeBareJid(raw);
        if (!bare) continue;
        resolvedCandidates.add(bare);
        if (isLidUser(bare) && sock.signalRepository?.lidMapping?.getPNForLID) {
          try {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(bare);
            if (pn) resolvedCandidates.add(normalizeBareJid(pn));
          } catch {
            // Ignore LID mapping error
          }
        } else if (bare.endsWith('@s.whatsapp.net') && sock.signalRepository?.lidMapping?.getLIDForPN) {
          try {
            const lid = await sock.signalRepository.lidMapping.getLIDForPN(bare);
            if (lid) resolvedCandidates.add(normalizeBareJid(lid));
          } catch {
            // Ignore PN mapping error
          }
        }
      }

      if (ctx.isGroup) {
        try {
          const meta = await getCachedGroupMetadata(sock, ctx.chatId);
          for (const p of meta.participants) {
            if (participantMatchesAny(p, Array.from(resolvedCandidates))) {
              if (p.id) resolvedCandidates.add(normalizeBareJid(p.id));
              if (p.lid) resolvedCandidates.add(normalizeBareJid(p.lid));
              if (p.phoneNumber) resolvedCandidates.add(normalizeBareJid(p.phoneNumber));
            }
          }
        } catch {
          // Ignore group metadata lookup failure
        }
      }

      const candidateList = Array.from(resolvedCandidates);
      const userStatuses = findStatusesForUser(candidateList);
      if (userStatuses.length === 0) {
        const verifiedPn = candidateList.find((c) => c.endsWith('@s.whatsapp.net'));
        const verifiedDigits = verifiedPn ? normalizePhone(jidUserPart(verifiedPn)) : '';
        const displayTarget =
          candidateList.map((c) => lookupKnownUserName(c)).find(Boolean) ||
          (isValidPhone(verifiedDigits) ? `+${verifiedDigits}` : 'this contact');
        const msg = `No cached photo/video/audio status found for *${displayTarget}* yet.\n• Text-only statuses are ignored. Ask them to post a photo/video/audio status while the bot is online, or reply directly to their status with \`${ctx.prefix}savestatus\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const toSend = wantAll ? userStatuses.slice(0, 5) : [userStatuses[0]];
      try {
        for (let i = 0; i < toSend.length; i += 1) {
          const note =
            !wantAll && userStatuses.length > 1
              ? `1 of ${userStatuses.length} cached media statuses — send ${ctx.prefix}savestatus @user all to get all`
              : wantAll && toSend.length > 1
                ? `Status ${i + 1} of ${toSend.length}`
                : undefined;
          await deliverStatusToBoth(toSend[i], note);
        }
        return `Delivered ${toSend.length} status media update(s) in chat${sameAsCurrentChat ? '' : ' and IB'}.`;
      } catch (err) {
        const msg = `Save status failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'save',
    aliases: ['vv2', 'grab', 'send'],
    category: 'media',
    description: 'Replied status, photo, video, audio ya View-Once ko aapke inbox (DM) mein bheje',
    usage: 'save (reply to status/media/view-once)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg =
          'Reply to someone’s WhatsApp Status, photo, video, audio, or View-Once media with `.save` to download it directly to your inbox.';
        await ctx.reply(msg);
        return msg;
      }
      const ctxInfo = extractContextInfo(ctx.msg.message);
      const stanzaId = ctxInfo?.stanzaId || '';
      const ownBotPhone = normalizePhone(jidUserPart(ctx.sock.user?.id));
      const targetDm =
        ctx.msg.key?.fromMe && ownBotPhone
          ? `${ownBotPhone}@s.whatsapp.net`
          : `${ctx.senderNumber}@s.whatsapp.net`;

      if (stanzaId) {
        await waitForViewOnceInflight(stanzaId);
        const preCached = getCachedViewOnceMedia(ctx.chatId, stanzaId);
        if (preCached && preCached.buffer.length > 0) {
          if (preCached.type === 'image') {
            await ctx.sock.sendMessage(targetDm, {
              image: preCached.buffer,
              mimetype: preCached.mimetype || 'image/jpeg',
              caption: preCached.caption,
            });
          } else if (preCached.type === 'video') {
            await ctx.sock.sendMessage(targetDm, {
              video: preCached.buffer,
              mimetype: preCached.mimetype || 'video/mp4',
              caption: preCached.caption,
            });
          } else {
            await ctx.sock.sendMessage(targetDm, {
              audio: preCached.buffer,
              mimetype: preCached.mimetype || 'audio/ogg; codecs=opus',
              ptt: preCached.ptt ?? true,
              seconds: preCached.seconds,
            });
          }
          if (targetDm !== ctx.chatId) {
            await ctx.reply(`Saved ${preCached.type} to your inbox.`);
          }
          return `Saved ${preCached.type} to inbox.`;
        }
      }

      const quoted = extractQuotedMessage(ctx.msg);
      const statusHit = stanzaId ? getStatusById(stanzaId) : undefined;
      if (statusHit) {
        try {
          const buf = await getOrDownloadStatusBuffer(ctx.sock, statusHit);
          if (!buf || buf.length === 0) {
            throw new Error('Status media payload expired or could not be downloaded.');
          }
          const senderTag = statusHit.senderPhone
            ? `${statusHit.pushName} (+${statusHit.senderPhone})`
            : statusHit.pushName;
          const caption = `*Saved Status* (${senderTag})${statusHit.caption ? `\n${statusHit.caption}` : ''}`;
          if (statusHit.mediaType === 'image') {
            await ctx.sock.sendMessage(targetDm, {
              image: buf,
              mimetype: statusHit.mimetype || 'image/jpeg',
              caption,
            });
          } else if (statusHit.mediaType === 'video') {
            await ctx.sock.sendMessage(targetDm, {
              video: buf,
              mimetype: statusHit.mimetype || 'video/mp4',
              caption,
            });
          } else {
            await ctx.sock.sendMessage(targetDm, {
              audio: buf,
              mimetype: statusHit.mimetype || 'audio/mp4',
              ptt: statusHit.ptt ?? false,
              seconds: statusHit.seconds,
            });
            await ctx.sock.sendMessage(targetDm, { text: caption });
          }
          if (targetDm !== ctx.chatId) {
            await ctx.reply(`Saved ${statusHit.mediaType} status to your inbox.`);
          }
          return `Saved ${statusHit.mediaType} status to inbox.`;
        } catch (err) {
          const msg = `Save failed: ${(err as Error).message}`;
          await ctx.reply(msg);
          return msg;
        }
      }

      const extractedQuotedStatus = extractStatusMediaPayload(quoted || ctxInfo?.quotedMessage);
      let inner = extractedQuotedStatus?.inner || unwrapViewOnce(quoted) || unwrapMessage(quoted) || quoted;
      let origKey = ctx.msg.key;

      // Check chat cache, status@broadcast cache, and disk metadata if WhatsApp stripped directPath/url
      if ((!inner || !hasValidMediaPayload(inner)) && stanzaId) {
        const cacheLookups = ctx.getCachedMessage
          ? [
              ctx.getCachedMessage(ctx.chatId, stanzaId),
              ctx.getCachedMessage('status@broadcast', stanzaId),
              ctxInfo?.remoteJid ? ctx.getCachedMessage(ctxInfo.remoteJid, stanzaId) : undefined,
            ]
          : [];
        for (const cachedOrig of cacheLookups) {
          if (cachedOrig?.message) {
            const cachedStatusMedia = extractStatusMediaPayload(cachedOrig.message);
            const cachedInner =
              cachedStatusMedia?.inner ||
              unwrapViewOnce(cachedOrig.message) ||
              unwrapMessage(cachedOrig.message);
            if (cachedInner && (hasValidMediaPayload(cachedInner) || !inner)) {
              inner = cachedInner;
              origKey = cachedOrig.key || origKey;
              if (hasValidMediaPayload(cachedInner)) break;
            }
          }
        }
        if (!inner || !hasValidMediaPayload(inner)) {
          const diskMeta = getCachedViewOnceMeta(stanzaId);
          if (diskMeta?.message && hasValidMediaPayload(diskMeta.message)) {
            inner = diskMeta.message;
            origKey = diskMeta.key || origKey;
          }
        }
      }

      if (!inner) {
        const msg = `Reply to a WhatsApp Status, photo, video, audio, or View-Once with \`${ctx.prefix}save\` (or use \`${ctx.prefix}savestatus @user\`).`;
        await ctx.reply(msg);
        return msg;
      }

      const type = detectMediaType(inner);
      if (type !== 'image' && type !== 'video' && type !== 'audio') {
        logger.info('save', `Ignored text-only or non-media target (${stanzaId || 'no-id'}).`);
        const msg = `Text-only messages/statuses are ignored. Reply to a status photo/video/audio or View-Once media with \`${ctx.prefix}save\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(inner)) {
        logger.info('save', `Ignored unsupported/unavailable media payload (${stanzaId || 'no-id'}).`);
        const msg =
          'Media payload expired or unavailable in cache (unsupported View-Once or stripped media key).';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const buf = await downloadMessageMedia(ctx.sock, { key: origKey, message: inner } as WAMessage);
        const caption =
          type === 'image'
            ? inner.imageMessage?.caption || undefined
            : type === 'video'
              ? inner.videoMessage?.caption || undefined
              : undefined;

        if (type === 'image') {
          await ctx.sock.sendMessage(targetDm, { image: buf, caption });
        } else if (type === 'video') {
          await ctx.sock.sendMessage(targetDm, { video: buf, caption });
        } else {
          await ctx.sock.sendMessage(targetDm, { audio: buf, mimetype: 'audio/mp4' });
        }

        if (targetDm !== ctx.chatId) {
          await ctx.reply(`Saved ${type} to your inbox.`);
        }
        return `Saved ${type} to inbox.`;
      } catch (err) {
        const msg = `Save failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'qr',
    aliases: ['qrcode'],
    category: 'media',
    description: 'Kisi bhi text ya link ka scannable QR code image banaye',
    usage: 'qr <text or url>',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const payload = ctx.text.trim();
      if (!payload) {
        const msg = `Usage: \`${ctx.prefix}qr https://example.com\``;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated QR Image] Generated QR for: ${payload}`;
        await ctx.reply(msg);
        return msg;
      }
      const buf = await QRCode.toBuffer(payload, { width: 512, margin: 2 });
      await ctx.sock.sendMessage(ctx.chatId, { image: buf }, ctx.msg ? { quoted: ctx.msg } : undefined);
      return 'QR image generated.';
    },
  },
  {
    name: 'calc',
    aliases: ['math'],
    category: 'media',
    description: 'Fast calculator (+, -, *, /, %, ^)',
    usage: 'calc <expression>',
    cooldownSeconds: 1,
    execute: async (ctx) => {
      const expr = ctx.text.trim();
      if (!expr) {
        const msg = `Usage: \`${ctx.prefix}calc (25 * 4) + 18\``;
        await ctx.reply(msg);
        return msg;
      }
      try {
        const result = evaluateSafeMath(expr);
        const msg = `*Result:* \`${expr}\` = *${result}*`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Calc error: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'say',
    aliases: ['echo'],
    category: 'media',
    description: 'Bot se clean message send karwaye',
    usage: 'say <text>',
    cooldownSeconds: 1,
    execute: async (ctx) => {
      const msg = ctx.text.trim();
      if (!msg) {
        const usage = `Usage: \`${ctx.prefix}say Hello everyone!\``;
        await ctx.reply(usage);
        return usage;
      }
      if (ctx.sock && !ctx.isSimulated) {
        await ctx.sock.sendMessage(ctx.chatId, { text: msg });
        return msg;
      }
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'quote',
    aliases: ['shayari', 'motivate'],
    category: 'media',
    description: 'VIP motivational ya status quote bheje',
    usage: 'quote',
    cooldownSeconds: 1,
    execute: async (ctx) => {
      const pick = VIP_QUOTES[Math.floor(Math.random() * VIP_QUOTES.length)];
      const msg = `*"${pick}"*\n— _${loadConfig().botName}_`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'tr',
    aliases: ['translate'],
    category: 'media',
    description: 'Text ya replied message ko kisi bhi language mein translate kare',
    usage: 'tr <lang> <text> (e.g. .tr ur Hello)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';

      const firstArg = ctx.args[0]?.toLowerCase() || '';
      const hasLang = /^[a-z]{2}(-[a-z]{2})?$/.test(firstArg);
      const targetLang = hasLang ? firstArg : 'ur';
      const sourceText = hasLang ? ctx.args.slice(1).join(' ').trim() || quotedText : ctx.text.trim() || quotedText;

      if (!sourceText) {
        const msg = `Usage: \`${ctx.prefix}tr ur Hello how are you\` or reply to any message with \`${ctx.prefix}tr en\`.`;
        await ctx.reply(msg);
        return msg;
      }

      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
          targetLang
        )}&dt=t&q=${encodeURIComponent(sourceText.slice(0, 1200))}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Translate HTTP ${res.status}`);
        const data = (await res.json()) as unknown[][];
        const translated = Array.isArray(data?.[0])
          ? (data[0] as unknown[][]).map((chunk) => String(chunk?.[0] || '')).join('')
          : '';
        if (!translated) throw new Error('Empty translation received');
        const msg = `*Translated (${targetLang.toUpperCase()}):*\n${translated}`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Translate failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'weather',
    aliases: ['mausam'],
    category: 'media',
    description: 'Kisi bhi city ka live weather aur temperature bataye',
    usage: 'weather <city>',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const city = ctx.text.trim();
      if (!city) {
        const msg = `Usage: \`${ctx.prefix}weather Lahore\``;
        await ctx.reply(msg);
        return msg;
      }
      try {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
          headers: { 'User-Agent': 'curl/8.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`Weather API HTTP ${res.status}`);
        const json = (await res.json()) as {
          current_condition?: Array<{
            temp_C?: string;
            FeelsLikeC?: string;
            humidity?: string;
            windspeedKmph?: string;
            weatherDesc?: Array<{ value?: string }>;
          }>;
          nearest_area?: Array<{ areaName?: Array<{ value?: string }>; country?: Array<{ value?: string }> }>;
        };
        const cur = json.current_condition?.[0];
        if (!cur) throw new Error('City not found');
        const area = json.nearest_area?.[0]?.areaName?.[0]?.value || city;
        const country = json.nearest_area?.[0]?.country?.[0]?.value || '';
        const cond = cur.weatherDesc?.[0]?.value || 'Clear';
        const msg = [
          `*Weather — ${area}${country ? `, ${country}` : ''}*`,
          `• Condition: ${cond}`,
          `• Temp: ${cur.temp_C}°C (Feels like ${cur.FeelsLikeC}°C)`,
          `• Humidity: ${cur.humidity}% | Wind: ${cur.windspeedKmph} km/h`,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Weather lookup failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'wa',
    aliases: ['checkwa', 'wame'],
    category: 'media',
    description: 'Phone number WhatsApp par active hai ya nahi check kare + direct chat link de',
    usage: 'wa <number>',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const num = normalizePhone(ctx.args[0] || '');
      if (!isValidPhone(num)) {
        const msg = `Usage: \`${ctx.prefix}wa 923001234567\``;
        await ctx.reply(msg);
        return msg;
      }
      if (!ctx.sock || ctx.isSimulated) {
        const msg = `[Simulated WA Check] Direct link: https://wa.me/${num}`;
        await ctx.reply(msg);
        return msg;
      }
      try {
        const res = await ctx.sock.onWhatsApp(`${num}@s.whatsapp.net`);
        const exists = Boolean(res?.[0]?.exists);
        const msg = exists
          ? `*WhatsApp Active*\n• Number: +${num}\n• Direct Link: https://wa.me/${num}`
          : `*Not Registered:* +${num} does not appear on WhatsApp.`;
        await ctx.reply(msg);
        return msg;
      } catch (err) {
        const msg = `Check failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'savedp',
    aliases: ['dpsave', 'getdp', 'pp', 'getpp', 'dp'],
    category: 'media',
    description: 'Mention, reply ya ID se kisi ki bhi profile photo isi chat mein send kare (.savedp)',
    usage: 'savedp (@user / ID / number / reply)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg =
          'Mention, reply, or pass a user ID/number with `.savedp` (or `.dpsave`) on WhatsApp to send their profile DP here.';
        await ctx.reply(msg);
        return msg;
      }

      const candidates = extractRawTargetCandidates(ctx.msg, ctx.args);
      if (candidates.length === 0 && !ctx.isGroup) {
        const peer = ctx.msg.key?.remoteJidAlt || ctx.chatId;
        if (peer) candidates.push(normalizeBareJid(peer));
      }
      if (candidates.length === 0) {
        const msg = `Mention a user, reply to their message, or pass an ID/number.\nUsage: \`${ctx.prefix}savedp @user\` or \`${ctx.prefix}savedp 923001234567\``;
        await ctx.reply(msg);
        return msg;
      }

      let targetJid = normalizeBareJid(candidates[0]);
      if (isLidUser(targetJid) && ctx.sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await ctx.sock.signalRepository.lidMapping.getPNForLID(targetJid);
          if (pn) targetJid = normalizeBareJid(pn);
        } catch {
          // Keep original JID if LID lookup unavailable
        }
      }

      try {
        let ppUrl: string | undefined;
        try {
          ppUrl = await ctx.sock.profilePictureUrl(targetJid, 'image');
        } catch {
          ppUrl = undefined;
        }
        if (!ppUrl) {
          ppUrl = await ctx.sock.profilePictureUrl(targetJid, 'preview').catch(() => undefined);
        }

        if (!ppUrl) {
          const msg = `Profile photo is hidden or unavailable for +${jidUserPart(targetJid)}.`;
          await ctx.reply(msg);
          return msg;
        }
        const res = await fetch(ppUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          throw new Error(`Failed fetching profile photo (HTTP ${res.status})`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const targetLabel = jidUserPart(targetJid);
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            image: buf,
            caption: `*Profile DP*\n• User: +${targetLabel}`,
          },
          { quoted: ctx.msg }
        );
        return `Sent profile DP of +${targetLabel} in chat.`;
      } catch (err) {
        const errMsg = (err as Error).message || 'Profile photo hidden or unavailable.';
        const msg = /item-not-found|401|404/i.test(errMsg)
          ? `Could not fetch DP for +${jidUserPart(targetJid)} (privacy hidden or no DP set).`
          : `Savedp failed: ${errMsg}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'react',
    category: 'media',
    description: 'Replied message par custom emoji reaction lagaye',
    usage: 'react <emoji>',
    cooldownSeconds: 1,
    execute: async (ctx) => {
      const emoji = ctx.args[0] || '🔥';
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = `Reply to a message with \`${ctx.prefix}react 🔥\` on WhatsApp.`;
        await ctx.reply(msg);
        return msg;
      }
      const ctxInfo = extractContextInfo(ctx.msg.message);
      if (!ctxInfo?.stanzaId) {
        const msg = `Reply to the message you want to react to with \`${ctx.prefix}react ❤️\`.`;
        await ctx.reply(msg);
        return msg;
      }
      await ctx.sock.sendMessage(ctx.chatId, {
        react: {
          text: emoji,
          key: {
            remoteJid: ctx.chatId,
            fromMe: Boolean(ctxInfo.participant === ctx.sock.user?.id),
            id: ctxInfo.stanzaId,
            participant: ctxInfo.participant || undefined,
          },
        },
      });
      return `Reacted with ${emoji}.`;
    },
  },
  {
    name: 'fakereact',
    aliases: ['freact', 'reactboost'],
    category: 'media',
    description: 'Replied message par custom/fake reactions aur reaction count card lagaye',
    usage: 'fakereact <emoji1> [count | emoji2 emoji3...]',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      const args = ctx.args.filter(Boolean);
      const firstEmoji = args[0] && !/^\d+$/.test(args[0]) ? args[0] : '🔥';
      const numericArg = args.find((a) => /^\d+$/.test(a));
      const emojiList = args.filter((a) => !/^\d+$/.test(a));
      if (emojiList.length === 0) emojiList.push(firstEmoji);

      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const count = numericArg ? Number(numericArg) : 25;
        const msg = `*Reaction Summary*\n${emojiList.map((e) => `• ${e} × *${count}*`).join('\n')}`;
        await ctx.reply(msg);
        return msg;
      }

      const ctxInfo = extractContextInfo(ctx.msg.message);
      if (!ctxInfo?.stanzaId) {
        const msg = `Reply to any message with \`${ctx.prefix}fakereact 🔥 99\` or \`${ctx.prefix}fakereact ❤️ 🔥 💯\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const targetKey = {
        remoteJid: ctx.chatId,
        fromMe: Boolean(ctxInfo.participant === ctx.sock.user?.id),
        id: ctxInfo.stanzaId,
        participant: ctxInfo.participant || undefined,
      };

      // Apply live reaction(s) sequentially
      const emojisToSend = emojiList.slice(0, 5);
      for (let i = 0; i < emojisToSend.length; i += 1) {
        await ctx.sock.sendMessage(ctx.chatId, {
          react: { text: emojisToSend[i], key: targetKey },
        });
        if (i < emojisToSend.length - 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      if (numericArg) {
        const count = Math.max(1, Math.min(999999, Number(numericArg)));
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            text: `*Message Reactions*\n${emojisToSend.map((e) => `${e}  *${count}*`).join('   ·   ')}`,
          },
          { quoted: ctx.msg }
        );
      }

      return `Applied reaction(s): ${emojisToSend.join(' ')}`;
    },
  },
  {
    name: 'contactsave',
    aliases: ['savecontact', 'vcard', 'vcf'],
    category: 'media',
    description: 'Replied/mentioned member ka contact vCard banaye taaki owner number save kar sake',
    usage: 'contactsave [@user | phone | reply] [Optional Custom Name]',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const candidates = extractRawTargetCandidates(ctx.msg, ctx.args);
      let targetJid = candidates[0] || (!ctx.isGroup ? ctx.chatId : '');

      if (!targetJid) {
        const msg = `Reply to a member's message, mention \`@user\`, or pass a phone number with \`${ctx.prefix}contactsave\`.`;
        await ctx.reply(msg);
        return msg;
      }

      let resolvedJid = normalizeBareJid(targetJid);
      if (isLidUser(resolvedJid) && ctx.sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await ctx.sock.signalRepository.lidMapping.getPNForLID(resolvedJid);
          if (pn) resolvedJid = normalizeBareJid(pn);
        } catch {
          // Keep original JID if LID lookup unavailable
        }
      }

      const cleanPhone = normalizePhone(jidUserPart(resolvedJid));
      if (!isValidPhone(cleanPhone)) {
        const msg = 'Could not resolve a valid phone number for that user (WhatsApp privacy LID hidden).';
        await ctx.reply(msg);
        return msg;
      }

      // Allow owner/user to specify a custom name after mention/number, else use known WhatsApp name
      const customName = ctx.args
        .filter((a) => !a.startsWith('@') && !/^\+?\d{7,15}$/.test(a))
        .join(' ')
        .trim();
      const displayName =
        customName ||
        lookupKnownUserName(resolvedJid) ||
        lookupKnownUserName(targetJid) ||
        `+${cleanPhone}`;

      const safeVcardName = displayName.replace(/[\r\n;]/g, ' ').trim();
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${safeVcardName}`,
        `TEL;type=CELL;type=VOICE;waid=${cleanPhone}:+${cleanPhone}`,
        'END:VCARD',
      ].join('\n');

      if (!ctx.sock || ctx.isSimulated) {
        const msg = `📱 *Contact Card Generated*\n• Name: *${safeVcardName}*\n• Number: +${cleanPhone}`;
        await ctx.reply(msg);
        return msg;
      }

      await ctx.sock.sendMessage(
        ctx.chatId,
        {
          contacts: {
            displayName: safeVcardName,
            contacts: [{ vcard }],
          },
        },
        { quoted: ctx.msg ?? undefined }
      );
      return `Sent vCard contact for ${safeVcardName} (+${cleanPhone}).`;
    },
  },
  {
    name: 'roast',
    aliases: ['burn', 'tease'],
    category: 'media',
    description: 'Mentioned ya replied user ko halka-phulka funny aur friendly roast kare',
    usage: 'roast [@user | name | reply]',
    cooldownSeconds: 4,
    execute: async (ctx) => {
      const targets = extractRawTargetCandidates(ctx.msg, ctx.args);
      const targetJid = targets[0] || '';
      const cleanedArgs = ctx.args.filter((a) => !a.startsWith('@') && !/^\+?\d{7,15}$/.test(a));
      const targetNum = targetJid ? jidUserPart(targetJid) : '';
      const targetName =
        (targetJid ? lookupKnownUserName(targetJid) : '') ||
        cleanedArgs.join(' ').trim() ||
        (targetNum ? `+${targetNum}` : ctx.pushName || 'Dost');

      const fallbackRoasts = [
        `Bhai ${targetName}, aapka Wi-Fi bhi aapke plans se zyada stable lagta hai! 😂`,
        `${targetName}, itna slow reply karte ho ke WhatsApp khud "Last seen last year" likhne wala hai! 😅`,
        `${targetName}, aapka alarm subah bajta hai toh phone bhi bolta hai "Rehne de bhai, kal uthna". ⏰😂`,
        `${targetName}, group mein aapki entry aisi hoti hai jaise charger 1% par lagaya ho! ⚡😄`,
        `${targetName}, itne serious mat bano — Google bhi kabhi kabhi "Did you mean..." puch leta hai! 🤣`,
      ];

      let roastLine = fallbackRoasts[Math.floor(Math.random() * fallbackRoasts.length)];
      if (isGeminiConfigured()) {
        try {
          roastLine = await generatePlayfulRoast(targetName);
        } catch {
          // Use playful fallback if Gemini request temporarily fails
        }
      }

      const headerTag = targetNum ? `@${targetNum}` : `*${targetName}*`;
      const output = `🔥 ${headerTag}\n${roastLine}`;
      if (ctx.sock && !ctx.isSimulated && targetJid) {
        await ctx.sock.sendMessage(
          ctx.chatId,
          { text: output, mentions: [targetJid] },
          { quoted: ctx.msg ?? undefined }
        );
      } else {
        await ctx.reply(output);
      }
      return output;
    },
  },
  {
    name: 'factcheck',
    aliases: ['verify', 'fc'],
    category: 'media',
    description: 'AI ke zariye kisi claim ya replied message ki haqeeqat aur misinformation check kare',
    usage: 'factcheck <claim> (or reply to a message)',
    cooldownSeconds: 4,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';
      const claim = ctx.text.trim() || quotedText;

      if (!claim) {
        const msg = `Reply to a message or enter a claim.\nExample: \`${ctx.prefix}factcheck Drinking warm water cures every virus\``;
        await ctx.reply(msg);
        return msg;
      }

      try {
        const analysis = await generateFactCheckReply(claim);
        const output = `🧐 *AI Fact-Check*\n\n${analysis}`;
        await ctx.reply(output);
        return output;
      } catch (err) {
        const msg = `Fact-check failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'summarize',
    aliases: ['tldr', 'summary', 'recap'],
    category: 'media',
    description: 'Group ki recent chat history (50–100+ messages) ka concise AI summary banaye',
    usage: 'summarize [count]',
    groupOnly: true,
    cooldownSeconds: 6,
    execute: async (ctx) => {
      const requested = ctx.args[0] ? Number(ctx.args[0]) : 60;
      const count =
        Number.isFinite(requested) && requested >= 10
          ? Math.min(120, Math.floor(requested))
          : 60;

      const messages = getRecentChatMessages(ctx.chatId, count);
      if (messages.length < 3) {
        const msg = `Not enough recent messages captured in this group yet (${messages.length}/3 minimum). Send a few chat messages and try \`${ctx.prefix}summarize\` again.`;
        await ctx.reply(msg);
        return msg;
      }

      const transcript = messages
        .map((m) => `${m.senderName}: ${m.text}`)
        .join('\n');

      try {
        const summary = await generateGroupSummary(transcript, messages.length);
        const output = `📝 *Chat Summary (Last ${messages.length} messages)*\n\n${summary}`;
        await ctx.reply(output);
        return output;
      } catch (err) {
        const msg = `Summarize failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'grammar',
    aliases: ['fixgrammar', 'spellcheck'],
    category: 'media',
    description: 'Text ya replied message ki grammar, spelling aur phrasing AI se sahi kare',
    usage: 'grammar <text> (or reply to a message)',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';
      const input = ctx.text.trim() || quotedText;

      if (!input) {
        const msg = `Reply to a message or pass text.\nExample: \`${ctx.prefix}grammar i goes to school yesterday\``;
        await ctx.reply(msg);
        return msg;
      }

      try {
        const result = await generateGrammarCorrection(input);
        const output = `✍️ *Grammar & Phrasing Check*\n\n${result}`;
        await ctx.reply(output);
        return output;
      } catch (err) {
        const msg = `Grammar check failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'checklink',
    aliases: ['scanlink', 'urlcheck', 'safetycheck'],
    category: 'media',
    description: 'Kisi URL ke redirects trace kar ke phishing, spoofing aur safety risk check kare',
    usage: 'checklink <url> (or reply to a message containing a link)',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const quotedText = ctx.msg ? extractBodyText(extractQuotedMessage(ctx.msg) || undefined) : '';
      const rawUrl = extractFirstValidUrl(ctx.text || quotedText);
      if (!rawUrl) {
        const msg = `Provide a link or reply to a message with a link.\nExample: \`${ctx.prefix}checklink https://example.com\``;
        await ctx.reply(msg);
        return msg;
      }

      const report = await inspectUrlSafety(rawUrl);
      await ctx.reply(report);
      return report;
    },
  },
  {
    name: 'bassboost',
    aliases: ['bass', 'bb'],
    category: 'media',
    description: 'Replied audio, voice note, ya short video/audio clip par heavy bass boost effect lagaye',
    usage: 'bassboost (reply to audio, voice note, or short video)',
    cooldownSeconds: 4,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to an audio file, voice note, or short video clip with `.bassboost`.';
        await ctx.reply(msg);
        return msg;
      }

      const quoted = extractQuotedMessage(ctx.msg);
      const direct = unwrapMessage(ctx.msg.message);
      const targetContent =
        quoted && (detectMediaType(quoted) === 'audio' || detectMediaType(quoted) === 'video')
          ? quoted
          : direct && (detectMediaType(direct) === 'audio' || detectMediaType(direct) === 'video')
            ? direct
            : null;

      if (!targetContent) {
        const msg = `Reply to an audio file, voice note, or short video clip with \`${ctx.prefix}bassboost\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(targetContent)) {
        const msg = 'Audio/video payload unavailable or expired. Resend it and reply with `.bassboost`.';
        await ctx.reply(msg);
        return msg;
      }

      const mediaType = detectMediaType(targetContent);
      const durationSec = Number(
        targetContent.audioMessage?.seconds ||
          targetContent.videoMessage?.seconds ||
          targetContent.ptvMessage?.seconds ||
          0
      );
      if (durationSec > 480) {
        const msg = 'Clip is too long for bass boosting (maximum 8 minutes). Send or reply to a shorter clip.';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const rawBuf = await downloadMessageMedia(ctx.sock, {
          key: ctx.msg.key,
          message: targetContent,
        } as WAMessage);

        if (rawBuf.length > 22 * 1024 * 1024) {
          const msg = 'Media file exceeds 22 MB limit for bass boost processing.';
          await ctx.reply(msg);
          return msg;
        }

        const boostedBuf = await applyBassBoostEffect(rawBuf, mediaType === 'video');
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            audio: boostedBuf,
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: 'FADI_KING_MD_BassBoosted.mp3',
          },
          { quoted: ctx.msg }
        );
        return 'Sent bass-boosted audio.';
      } catch (err) {
        const errText = (err as Error).message || 'Processing failed';
        const friendly = /no audio|does not contain any stream/i.test(errText)
          ? 'The replied video has no audio track to bass boost.'
          : `Bass boost failed: ${errText}`;
        await ctx.reply(friendly);
        return friendly;
      }
    },
  },
  {
    name: 'stickerinfo',
    aliases: ['sinfo', 'stickerdata', 'stinfo'],
    category: 'media',
    description: 'Replied sticker ka pack name, author/publisher, animated/static type aur dimensions inspect kare',
    usage: 'stickerinfo (reply to a sticker)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg = 'Reply to any WhatsApp sticker with `.stickerinfo` to inspect its pack name, author, type, and dimensions.';
        await ctx.reply(msg);
        return msg;
      }

      const quoted = extractQuotedMessage(ctx.msg);
      const stickerMsg = quoted?.stickerMessage;
      if (!stickerMsg) {
        const msg = `Reply to a WhatsApp sticker using \`${ctx.prefix}stickerinfo\`.`;
        await ctx.reply(msg);
        return msg;
      }

      let inspected: ReturnType<typeof inspectWebpStickerBuffer> | null = null;
      if (hasValidMediaPayload(quoted)) {
        try {
          const buf = await downloadMessageMedia(ctx.sock, {
            key: ctx.msg.key,
            message: quoted,
          } as WAMessage);
          inspected = inspectWebpStickerBuffer(buf);
        } catch {
          // Proceed with protobuf metadata if download fails
        }
      }

      const isAnimated = Boolean(stickerMsg.isAnimated || inspected?.isAnimated);
      const isLottie = Boolean(stickerMsg.isLottie);
      const kindLabel = isLottie
        ? 'Animated (Lottie)'
        : isAnimated
          ? 'Animated (WebP)'
          : 'Static (WebP)';

      const width = inspected?.width || Number(stickerMsg.width || 0) || undefined;
      const height = inspected?.height || Number(stickerMsg.height || 0) || undefined;
      const sizeBytes = inspected?.fileSizeBytes || Number(stickerMsg.fileLength || 0) || 0;
      const sizeLabel =
        sizeBytes > 0
          ? sizeBytes >= 1024 * 1024
            ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`
            : `${(sizeBytes / 1024).toFixed(1)} KB`
          : 'Unknown';

      const emojisText =
        inspected?.emojis && inspected.emojis.length > 0 ? inspected.emojis.join(' ') : '';

      const lines = [
        `🏷️ *Sticker Metadata Inspector*`,
        `• Pack Name: *${inspected?.packName || 'Not embedded'}*`,
        `• Author / Publisher: *${inspected?.packPublisher || 'Not embedded'}*`,
        `• Type: *${kindLabel}*`,
        `• Dimensions: *${width && height ? `${width} × ${height} px` : 'Unknown'}*`,
        `• File Size: *${sizeLabel}*`,
        ...(inspected?.packId ? [`• Pack ID: \`${inspected.packId}\``] : []),
        ...(emojisText ? [`• Emojis: ${emojisText}`] : []),
        ...(stickerMsg.accessibilityLabel ? [`• Label: ${stickerMsg.accessibilityLabel}`] : []),
      ];

      const output = lines.join('\n');
      await ctx.reply(output);
      return output;
    },
  },
  {
    name: 'poetry',
    aliases: ['poem', 'nazm', 'ghazal'],
    category: 'media',
    description: 'Topic, mood ya language ke mutabiq Urdu/Roman Urdu ya English poetry aur shayari generate kare',
    usage: 'poetry [topic / mood / language] (e.g. .poetry friendship Roman Urdu)',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';
      const topic = ctx.text.trim() || quotedText || 'Heartfelt motivational & emotional Urdu shayari';

      try {
        const verse = await generatePoetryReply(topic);
        const output = `✍️ *Poetry & Shayari*\n\n${verse}`;
        await ctx.reply(output);
        return output;
      } catch (err) {
        const msg = `Poetry generation failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'bio',
    aliases: ['biogen', 'instabio', 'wabio'],
    category: 'media',
    description: 'Keywords ya personality vibe se WhatsApp, Instagram aur TikTok ke liye stylish bios generate kare',
    usage: 'bio <keywords / vibe / role> (e.g. .bio Gamer, Lahore, Minimalist)',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const quoted = ctx.msg ? extractQuotedMessage(ctx.msg) : null;
      const quotedText = quoted ? extractBodyText(quoted).trim() : '';
      const keywords = ctx.text.trim() || quotedText;

      if (!keywords) {
        const msg = `Provide keywords, vibe, or role.\nExample: \`${ctx.prefix}bio Developer, Cricket lover, Minimalist\``;
        await ctx.reply(msg);
        return msg;
      }

      try {
        const options = await generateBioOptionsReply(keywords);
        const output = `✨ *Stylish Profile Bios (${keywords.slice(0, 40)})*\n\n${options}`;
        await ctx.reply(output);
        return output;
      } catch (err) {
        const msg = `Bio generation failed: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  {
    name: 'cricket',
    aliases: ['score', 'cric', 'livecricket'],
    category: 'media',
    description: 'Live cricket match scores, series updates aur current status fetch kare',
    usage: 'cricket [team or series filter]',
    cooldownSeconds: 4,
    execute: async (ctx) => {
      try {
        const summary = await fetchLiveCricketSummary(ctx.text.trim());
        await ctx.reply(summary);
        return summary;
      } catch (err) {
        const msg = `Cricket scores unavailable right now: ${(err as Error).message}`;
        await ctx.reply(msg);
        return msg;
      }
    },
  },
  ...createSocialDownloaderCommands(),
];

interface CricbuzzInningsScore {
  inningsId?: number;
  runs?: number;
  wickets?: number;
  overs?: number;
  isDeclared?: boolean;
}

interface CricbuzzMatchEntry {
  matchInfo?: {
    matchId?: number;
    seriesName?: string;
    matchDesc?: string;
    matchFormat?: string;
    state?: string;
    status?: string;
    team1?: { teamName?: string; teamSName?: string };
    team2?: { teamName?: string; teamSName?: string };
    venueInfo?: { ground?: string; city?: string };
  };
  matchScore?: {
    team1Score?: Record<string, CricbuzzInningsScore>;
    team2Score?: Record<string, CricbuzzInningsScore>;
  };
}

function formatTeamInningsScore(scoreObj?: Record<string, CricbuzzInningsScore>): string {
  if (!scoreObj) return '';
  const innings = Object.values(scoreObj)
    .filter((i) => typeof i?.runs === 'number')
    .sort((a, b) => Number(a.inningsId || 0) - Number(b.inningsId || 0));
  if (innings.length === 0) return '';
  return innings
    .map((inng) => {
      const wkts = typeof inng.wickets === 'number' ? `/${inng.wickets}` : '';
      const ov = typeof inng.overs === 'number' ? ` (${inng.overs})` : '';
      const dec = inng.isDeclared ? 'd' : '';
      return `${inng.runs}${wkts}${dec}${ov}`;
    })
    .join(' & ');
}

function extractCricbuzzMatchesFromHtml(html: string): CricbuzzMatchEntry[] {
  const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const seenIds = new Set<number>();
  const matches: CricbuzzMatchEntry[] = [];
  const marker = '{"matchInfo":{';
  let cursor = 0;

  while (cursor < unescaped.length) {
    const start = unescaped.indexOf(marker, cursor);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < unescaped.length && i < start + 8000; i += 1) {
      const ch = unescaped[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
    }

    if (end > start) {
      try {
        const obj = JSON.parse(unescaped.slice(start, end)) as CricbuzzMatchEntry;
        const id = Number(obj.matchInfo?.matchId || 0);
        if (id && !seenIds.has(id) && obj.matchInfo?.team1 && obj.matchInfo?.team2) {
          seenIds.add(id);
          matches.push(obj);
        }
      } catch {
        // Ignore partial chunk split objects
      }
      cursor = end;
    } else {
      cursor = start + marker.length;
    }
  }

  return matches;
}

function decodeBasicXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export async function fetchLiveCricketSummary(queryFilter?: string): Promise<string> {
  const filter = (queryFilter || '').trim().toLowerCase();

  // 1. Primary rich source: Cricbuzz live scores
  try {
    const res = await fetch('https://www.cricbuzz.com/cricket-match/live-scores', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const html = await res.text();
      const parsed = extractCricbuzzMatchesFromHtml(html);

      if (parsed.length > 0) {
        const priority = (stateRaw?: string): number => {
          const s = (stateRaw || '').toLowerCase();
          if (s.includes('progress') || s.includes('live')) return 0;
          if (s.includes('delay') || s.includes('break') || s.includes('stumps') || s.includes('rain')) return 1;
          if (s.includes('complete')) return 2;
          return 3;
        };

        const sorted = [...parsed].sort(
          (a, b) => priority(a.matchInfo?.state) - priority(b.matchInfo?.state)
        );

        const filtered = filter
          ? sorted.filter((m) => {
              const hay = [
                m.matchInfo?.seriesName,
                m.matchInfo?.matchDesc,
                m.matchInfo?.team1?.teamName,
                m.matchInfo?.team1?.teamSName,
                m.matchInfo?.team2?.teamName,
                m.matchInfo?.team2?.teamSName,
                m.matchInfo?.status,
              ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
              return hay.includes(filter);
            })
          : sorted;

        const list = (filtered.length > 0 ? filtered : sorted).slice(0, 7);
        const filterNote =
          filter && filtered.length === 0
            ? `_No exact match for "${queryFilter}" — showing top live matches:_\n\n`
            : '';

        const blocks = list.map((m, idx) => {
          const info = m.matchInfo!;
          const t1 = info.team1?.teamSName || info.team1?.teamName || 'Team 1';
          const t2 = info.team2?.teamSName || info.team2?.teamName || 'Team 2';
          const s1 = formatTeamInningsScore(m.matchScore?.team1Score);
          const s2 = formatTeamInningsScore(m.matchScore?.team2Score);
          const stateRaw = (info.state || '').toLowerCase();
          const badge =
            stateRaw.includes('progress') || stateRaw.includes('live')
              ? '🔴 LIVE'
              : stateRaw.includes('delay') || stateRaw.includes('break') || stateRaw.includes('stumps')
                ? '🟡 ' + (info.state || 'Update')
                : stateRaw.includes('complete')
                  ? '✅ Result'
                  : '🕒 ' + (info.state || 'Scheduled');

          const scoreLines =
            s1 || s2
              ? [`   ${t1}: *${s1 || 'Yet to bat'}*`, `   ${t2}: *${s2 || 'Yet to bat'}*`]
              : [];

          return [
            `${idx + 1}. *${info.team1?.teamName || t1} vs ${info.team2?.teamName || t2}* (${info.matchDesc || info.matchFormat || 'Match'})`,
            ...(info.seriesName ? [`   _${info.seriesName}_`] : []),
            ...scoreLines,
            `   ${badge}: ${info.status || info.state || 'Live updates'}`,
          ].join('\n');
        });

        return [
          `🏏 *LIVE CRICKET SCORES*`,
          '',
          `${filterNote}${blocks.join('\n\n')}`,
        ].join('\n');
      }
    }
  } catch {
    // Fall back to ESPNcricinfo RSS feed below
  }

  // 2. Fallback source: ESPNcricinfo live scores XML RSS
  const rssRes = await fetch('https://static.cricinfo.com/rss/livescores.xml', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!rssRes.ok) {
    throw new Error(`Cricket feed returned HTTP ${rssRes.status}`);
  }
  const xml = await rssRes.text();
  const titles = Array.from(xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g))
    .map((m) => decodeBasicXmlEntities(m[1]))
    .filter(Boolean);

  if (titles.length === 0) {
    return '🏏 *Live Cricket Scores*\nNo active or recent matches found right now.';
  }

  const matched = filter ? titles.filter((t) => t.toLowerCase().includes(filter)) : titles;
  const shown = (matched.length > 0 ? matched : titles).slice(0, 10);
  const note =
    filter && matched.length === 0
      ? `_No exact match for "${queryFilter}" — showing current scoreboard:_\n\n`
      : '';

  return [
    `🏏 *LIVE CRICKET SCORES*`,
    '',
    `${note}${shown.map((t, i) => `${i + 1}. *${t}*`).join('\n')}`,
  ].join('\n');
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('[::1]')) return true;
  return false;
}

async function inspectUrlSafety(initialUrl: string): Promise<string> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(initialUrl);
  } catch {
    return `⚠️ *Invalid URL:* Could not parse \`${initialUrl}\`.`;
  }

  const findings: string[] = [];
  let riskScore = 0;

  if (currentUrl.protocol !== 'https:') {
    riskScore += 2;
    findings.push(`Uses unencrypted *${currentUrl.protocol.replace(':', '').toUpperCase()}* instead of HTTPS.`);
  }

  const host = currentUrl.hostname.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    riskScore += 3;
    findings.push('Host is a raw IP address rather than a registered domain.');
  }
  if (host.includes('xn--')) {
    riskScore += 3;
    findings.push('Contains Punycode (`xn--`) which can be used for look-alike domain spoofing.');
  }

  const shorteners = new Set([
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'ow.ly', 'shorturl.at',
  ]);
  if (shorteners.has(host)) {
    riskScore += 1;
    findings.push(`URL shortener detected (*${host}*). Tracing redirect target...`);
  }

  const riskyTlds = ['.tk', '.ml', '.ga', '.cf', '.gq', '.top', '.xyz', '.zip', '.mov', '.click', '.work'];
  if (riskyTlds.some((tld) => host.endsWith(tld))) {
    riskScore += 2;
    findings.push(`Uses high-risk or commonly abused TLD (*${host.slice(host.lastIndexOf('.'))}*).`);
  }

  if (
    /whatsapp|paypal|binance|facebook|instagram|google|apple|amazon|bank|verify|login|free-?nitro|claim|airdrop/i.test(
      host + currentUrl.pathname
    ) &&
    !/(^|\.)(whatsapp\.com|whatsapp\.net|facebook\.com|instagram\.com|google\.com|youtube\.com|apple\.com|amazon\.com|paypal\.com|binance\.com|github\.com)$/i.test(
      host
    )
  ) {
    riskScore += 3;
    findings.push('Domain or path mimics a sensitive brand/login or giveaway lure.');
  }

  if (currentUrl.username || currentUrl.password || currentUrl.href.includes('@')) {
    riskScore += 3;
    findings.push('Contains `@` or embedded credentials in URL (classic spoofing technique).');
  }

  const chain: string[] = [currentUrl.toString()];
  let finalUrl = currentUrl.toString();
  let httpStatus = 'Not queried';

  if (isPrivateOrLoopbackHost(host)) {
    riskScore += 4;
    findings.push('Points to a private/loopback internal network address (blocked from probing).');
  } else {
    let cursor = currentUrl.toString();
    for (let hop = 0; hop < 5; hop += 1) {
      try {
        const parsedHop = new URL(cursor);
        if (isPrivateOrLoopbackHost(parsedHop.hostname)) {
          riskScore += 4;
          findings.push(`Redirected into private/local host (*${parsedHop.hostname}*).`);
          break;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(cursor, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkSafetyCheck/1.0)' },
        });
        clearTimeout(timer);
        httpStatus = `HTTP ${res.status}`;
        void res.body?.cancel().catch(() => {});

        const location = res.headers.get('location');
        if (location && res.status >= 300 && res.status < 400) {
          const nextUrl = new URL(location, cursor).toString();
          chain.push(nextUrl);
          cursor = nextUrl;
          finalUrl = nextUrl;
        } else {
          break;
        }
      } catch (err) {
        httpStatus = `Unreachable (${(err as Error).name === 'AbortError' ? 'Timeout' : 'Network error'})`;
        break;
      }
    }
  }

  if (chain.length > 2) {
    riskScore += 1;
    findings.push(`Followed *${chain.length - 1}* HTTP redirect(s) to final destination.`);
  }

  const finalHost = (() => {
    try {
      return new URL(finalUrl).hostname.toLowerCase();
    } catch {
      return host;
    }
  })();

  if (finalHost !== host && riskyTlds.some((tld) => finalHost.endsWith(tld))) {
    riskScore += 2;
    findings.push(`Final destination domain (*${finalHost}*) uses a suspicious TLD.`);
  }

  const verdict =
    riskScore >= 4
      ? '🔴 *HIGH RISK / SUSPICIOUS*'
      : riskScore >= 2
        ? '🟡 *CAUTION ADVISED*'
        : '🟢 *LOOKS SAFE (Low Risk)*';

  return [
    `🔎 *Link Safety Inspection*`,
    `• Verdict: ${verdict}`,
    `• Submitted Host: \`${host}\``,
    `• Final Destination: ${finalUrl}`,
    `• Probe Status: ${httpStatus} (${chain.length - 1} redirect${chain.length - 1 === 1 ? '' : 's'})`,
    ...(findings.length > 0
      ? ['', '*Signals Found:*', ...findings.map((f) => `• ${f}`)]
      : ['', '• No common phishing, IP-literal, punycode, or HTTP downgrade red flags detected.']),
  ].join('\n');
}

async function runSocialDownloaderCommand(
  ctx: CommandContext,
  platform: SocialPlatform,
  label: string,
  audioOnly = false
): Promise<string> {
  const quotedMsgText = ctx.msg ? extractBodyText(extractQuotedMessage(ctx.msg) || undefined) : '';
  const url = extractFirstValidUrl(ctx.text || quotedMsgText);
  if (!url) {
    const msg = `Provide a ${label} link.\nUsage: \`${ctx.prefix}${ctx.commandName} <url>\``;
    await ctx.reply(msg);
    return msg;
  }

  if (!ctx.sock || ctx.isSimulated) {
    const msg = `[Simulated] Ready to download ${label} media without watermark from:\n${url}`;
    await ctx.reply(msg);
    return msg;
  }

  await ctx.reply(`⏳ Downloading ${label} media (${audioOnly ? 'Audio' : 'No-Watermark HD'})...`);

  try {
    const result = await downloadSocialMedia({ platform, url, audioOnly });
    const cfg = loadConfig();
    const captionHeader = [
      `✅ *${label} Downloader*`,
      result.title ? `• Title: ${result.title}` : '',
      result.author ? `• Creator: ${result.author}` : '',
      `• Downloaded by *${cfg.botName || 'FADI KING MD'}*`,
    ]
      .filter(Boolean)
      .join('\n');

    for (let i = 0; i < result.items.length; i += 1) {
      const item = result.items[i];
      const itemCaption = i === 0 ? captionHeader : undefined;
      if (item.kind === 'video') {
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            video: item.buffer,
            mimetype: item.mimetype || 'video/mp4',
            caption: itemCaption,
          },
          { quoted: ctx.msg ?? undefined }
        );
      } else if (item.kind === 'image') {
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            image: item.buffer,
            caption: itemCaption,
          },
          { quoted: ctx.msg ?? undefined }
        );
      } else {
        await ctx.sock.sendMessage(
          ctx.chatId,
          {
            audio: item.buffer,
            mimetype: item.mimetype || 'audio/mpeg',
            ptt: false,
            fileName: item.filename || `${platform}-audio.mp3`,
          },
          { quoted: ctx.msg ?? undefined }
        );
      }
    }

    return `Delivered ${result.items.length} ${label} media file(s).`;
  } catch (err) {
    const msg = `${label} download failed: ${(err as Error).message}`;
    await ctx.reply(msg);
    return msg;
  }
}

function createSocialDownloaderCommands(): BotCommand[] {
  return [
    {
      name: 'tiktok',
      aliases: ['tt', 'tiktokdl', 'ttdl'],
      category: 'media',
      description: 'TikTok video ya slideshow bina watermark HD quality mein download kare',
      usage: 'tiktok <url>',
      cooldownSeconds: 5,
      execute: async (ctx) => {
        const audioOnly = ctx.args.some((a) => a.toLowerCase() === '--audio' || a.toLowerCase() === 'audio');
        return runSocialDownloaderCommand(ctx, 'tiktok', 'TikTok', audioOnly);
      },
    },
    {
      name: 'ig',
      aliases: ['instagram', 'reel', 'igdl'],
      category: 'media',
      description: 'Instagram Reels, Videos aur Posts bina watermark download kare',
      usage: 'ig <url>',
      cooldownSeconds: 5,
      execute: async (ctx) => runSocialDownloaderCommand(ctx, 'instagram', 'Instagram', false),
    },
    {
      name: 'yt',
      aliases: ['youtube', 'ytmp4', 'ytmp3', 'yta', 'ytv'],
      category: 'media',
      description: 'YouTube video (.yt/.ytmp4) ya MP3 audio (.ytmp3/.yta) download kare',
      usage: 'yt <url> | ytmp3 <url>',
      cooldownSeconds: 5,
      execute: async (ctx) => {
        const cmd = ctx.commandName.toLowerCase();
        const audioOnly =
          cmd === 'ytmp3' ||
          cmd === 'yta' ||
          ctx.args.some((a) => a.toLowerCase() === '--audio' || a.toLowerCase() === 'mp3');
        return runSocialDownloaderCommand(ctx, 'youtube', 'YouTube', audioOnly);
      },
    },
    {
      name: 'fb',
      aliases: ['facebook', 'fbdl', 'fbvideo'],
      category: 'media',
      description: 'Facebook Reels aur HD videos direct download kare',
      usage: 'fb <url>',
      cooldownSeconds: 5,
      execute: async (ctx) => runSocialDownloaderCommand(ctx, 'facebook', 'Facebook', false),
    },
    {
      name: 'twitter',
      aliases: ['x', 'tw', 'xdl'],
      category: 'media',
      description: 'Twitter / X videos aur photos high quality mein download kare',
      usage: 'twitter <url>',
      cooldownSeconds: 5,
      execute: async (ctx) => runSocialDownloaderCommand(ctx, 'twitter', 'Twitter / X', false),
    },
    {
      name: 'pinterest',
      aliases: ['pinmedia', 'pindl', 'pint'],
      category: 'media',
      description: 'Pinterest videos aur high-res images download kare',
      usage: 'pinterest <url>',
      cooldownSeconds: 5,
      execute: async (ctx) => runSocialDownloaderCommand(ctx, 'pinterest', 'Pinterest', false),
    },
  ];
}
