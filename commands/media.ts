import QRCode from 'qrcode';
import type { WAMessage } from '@whiskeysockets/baileys';
import { isValidPhone, loadConfig, normalizePhone } from '../config/bot.config.ts';
import {
  extractBodyText,
  extractContextInfo,
  extractRawTargetCandidates,
  hasValidMediaPayload,
  isLidUser,
  jidUserPart,
  normalizeBareJid,
  unwrapMessage,
} from '../utils/jidHelper.ts';
import {
  convertMediaToWebpSticker,
  convertStickerToPng,
  detectMediaType,
  downloadMessageMedia,
  extractQuotedMessage,
  getCachedViewOnceMedia,
  synthesizeTtsVoiceNote,
  unwrapViewOnce,
  waitForViewOnceInflight,
} from '../utils/mediaHelper.ts';
import { vipStore } from '../utils/vipStore.ts';
import type { BotCommand } from './types.ts';

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

      const ctxInfo = extractContextInfo(ctx.msg.message);
      const stanzaId = ctxInfo?.stanzaId || '';

      // 1. Check pre-cached View-Once media buffer first (works even after View-Once was opened)
      if (stanzaId) {
        await waitForViewOnceInflight(stanzaId);
        const preCached = getCachedViewOnceMedia(ctx.chatId, stanzaId);
        if (preCached) {
          if (preCached.type === 'image') {
            await ctx.sock.sendMessage(ctx.chatId, {
              image: preCached.buffer,
              caption: preCached.caption || `View-Once extracted by ${loadConfig().botName}`,
            });
          } else if (preCached.type === 'video') {
            await ctx.sock.sendMessage(ctx.chatId, {
              video: preCached.buffer,
              caption: preCached.caption || `View-Once extracted by ${loadConfig().botName}`,
            });
          } else {
            await ctx.sock.sendMessage(ctx.chatId, {
              audio: preCached.buffer,
              mimetype: preCached.mimetype || 'audio/ogg; codecs=opus',
              ptt: Boolean(preCached.ptt ?? true),
              seconds: preCached.seconds,
            });
          }
          return 'View-Once media unwrapped.';
        }
      }

      const quoted = extractQuotedMessage(ctx.msg);
      let inner = unwrapViewOnce(quoted) || unwrapViewOnce(ctx.msg.message) || quoted;
      let sourceKey = stanzaId
        ? {
            remoteJid: ctx.chatId,
            fromMe: false,
            id: stanzaId,
            participant: ctxInfo?.participant || undefined,
          }
        : ctx.msg.key;

      // 2. Fallback to cached original WAMessage (WhatsApp strips mediaKey from quoted View-Once replies)
      if ((!inner || !hasValidMediaPayload(inner)) && stanzaId && ctx.getCachedMessage) {
        const cachedOrig = ctx.getCachedMessage(ctx.chatId, stanzaId);
        if (cachedOrig?.message) {
          const cachedInner =
            unwrapViewOnce(cachedOrig.message) || unwrapMessage(cachedOrig.message);
          if (cachedInner && hasValidMediaPayload(cachedInner)) {
            inner = cachedInner;
            sourceKey = cachedOrig.key || sourceKey;
          }
        }
      }

      if (!inner) {
        const msg = `Reply to a View-Once photo, video, or voice note with \`${ctx.prefix}vv\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const type = detectMediaType(inner);
      if (type !== 'image' && type !== 'video' && type !== 'audio') {
        const msg = 'No View-Once image, video, or voice note detected in the quoted message.';
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(inner)) {
        const msg =
          'This View-Once media was opened or sent before the bot started caching. Ask the sender to send it again.';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const targetInfo: WAMessage = {
          key: sourceKey,
          message: inner,
        };
        const buffer = await downloadMessageMedia(ctx.sock, targetInfo);

        if (type === 'image') {
          await ctx.sock.sendMessage(ctx.chatId, {
            image: buffer,
            caption: inner.imageMessage?.caption || `View-Once extracted by ${loadConfig().botName}`,
          });
        } else if (type === 'video') {
          await ctx.sock.sendMessage(ctx.chatId, {
            video: buffer,
            caption: inner.videoMessage?.caption || `View-Once extracted by ${loadConfig().botName}`,
          });
        } else {
          const audioMeta = inner.audioMessage;
          await ctx.sock.sendMessage(ctx.chatId, {
            audio: buffer,
            mimetype: audioMeta?.mimetype || 'audio/ogg; codecs=opus',
            ptt: audioMeta?.ptt !== false,
            seconds: audioMeta?.seconds || undefined,
          });
        }
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
    name: 'save',
    aliases: ['vv2', 'grab', 'savestatus', 'statusdl', 'send'],
    category: 'media',
    description: 'Kisi ka WhatsApp status, media, ya View-Once download karke aapke inbox (DM) mein bheje',
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
      const quoted = extractQuotedMessage(ctx.msg);
      let inner = unwrapViewOnce(quoted) || unwrapMessage(quoted) || quoted;

      // Check both chat cache AND status@broadcast cache if WhatsApp stripped directPath/url
      if ((!inner || !hasValidMediaPayload(inner)) && ctxInfo?.stanzaId && ctx.getCachedMessage) {
        const cacheLookups = [
          ctx.getCachedMessage(ctx.chatId, ctxInfo.stanzaId),
          ctx.getCachedMessage('status@broadcast', ctxInfo.stanzaId),
          ctxInfo.remoteJid ? ctx.getCachedMessage(ctxInfo.remoteJid, ctxInfo.stanzaId) : undefined,
        ];
        for (const cachedOrig of cacheLookups) {
          if (cachedOrig?.message) {
            const cachedInner =
              unwrapViewOnce(cachedOrig.message) || unwrapMessage(cachedOrig.message);
            if (cachedInner && (hasValidMediaPayload(cachedInner) || !inner)) {
              inner = cachedInner;
              if (hasValidMediaPayload(cachedInner)) break;
            }
          }
        }
      }

      const ownBotPhone = normalizePhone(jidUserPart(ctx.sock.user?.id));
      const targetDm =
        ctx.msg.key?.fromMe && ownBotPhone
          ? `${ownBotPhone}@s.whatsapp.net`
          : `${ctx.senderNumber}@s.whatsapp.net`;

      if (!inner) {
        const msg = `Reply to a WhatsApp Status, photo, video, audio, or View-Once with \`${ctx.prefix}save\`.`;
        await ctx.reply(msg);
        return msg;
      }

      const type = detectMediaType(inner);
      if (type !== 'image' && type !== 'video' && type !== 'audio') {
        // Support saving text-only WhatsApp Statuses too
        const textStatus = extractBodyText(inner).trim();
        if (textStatus) {
          await ctx.sock.sendMessage(targetDm, { text: `*Saved Status Text:*\n\n${textStatus}` });
          if (targetDm !== ctx.chatId) {
            await ctx.reply('Status text saved to your inbox.');
          }
          return 'Status text saved to inbox.';
        }
        const msg = `Reply to a status photo/video/audio or View-Once media with \`${ctx.prefix}save\`.`;
        await ctx.reply(msg);
        return msg;
      }

      if (!hasValidMediaPayload(inner)) {
        const msg =
          'Media payload expired or unavailable in cache. Open/view the status again and reply with `.save`.';
        await ctx.reply(msg);
        return msg;
      }

      try {
        const buf = await downloadMessageMedia(ctx.sock, { key: ctx.msg.key, message: inner } as WAMessage);
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
    description: 'Mention, reply ya ID se kisi ki bhi profile photo IB mein save kare (.dpsave)',
    usage: 'dpsave (@user / ID / number / reply)',
    cooldownSeconds: 2,
    execute: async (ctx) => {
      if (!ctx.sock || !ctx.msg || ctx.isSimulated) {
        const msg =
          'Mention, reply, or pass a user ID/number with `.dpsave` (or `.savedp`) on WhatsApp to save their profile DP to your IB.';
        await ctx.reply(msg);
        return msg;
      }

      const candidates = extractRawTargetCandidates(ctx.msg, ctx.args);
      if (candidates.length === 0 && !ctx.isGroup) {
        const peer = ctx.msg.key?.remoteJidAlt || ctx.chatId;
        if (peer) candidates.push(normalizeBareJid(peer));
      }
      if (candidates.length === 0) {
        const msg = `Mention a user, reply to their message, or pass an ID/number.\nUsage: \`${ctx.prefix}dpsave @user\` or \`${ctx.prefix}dpsave 923001234567\``;
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

      const cfg = loadConfig();
      const ownBotPhone = normalizePhone(jidUserPart(ctx.sock.user?.id));
      const senderPhone = normalizePhone(ctx.senderNumber);
      const targetDmPhone =
        ctx.msg.key?.fromMe && ownBotPhone
          ? ownBotPhone
          : senderPhone || ownBotPhone || cfg.ownerNumber;
      const targetDm = `${targetDmPhone}@s.whatsapp.net`;

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
        await ctx.sock.sendMessage(targetDm, {
          image: buf,
          caption: `*Saved Profile DP*\n• User: +${targetLabel}`,
        });
        if (targetDm !== ctx.chatId) {
          await ctx.reply(`Saved profile DP of +${targetLabel} to your IB!`);
        }
        return `Saved DP of +${targetLabel} to IB.`;
      } catch (err) {
        const errMsg = (err as Error).message || 'Profile photo hidden or unavailable.';
        const msg = /item-not-found|401|404/i.test(errMsg)
          ? `Could not fetch DP for +${jidUserPart(targetJid)} (privacy hidden or no DP set).`
          : `DPSave failed: ${errMsg}`;
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
];
