import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import { findCommand } from '../commands/index.ts';
import type { CommandContext } from '../commands/types.ts';
import { generateAiChatReply } from '../utils/geminiService.ts';
import {
  extractBodyText,
  extractContextInfo,
  getBotJids,
  jidUserPart,
  normalizeBareJid,
  rememberUserName,
  resolveSenderInfo,
} from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import { recordChatMessage } from '../utils/chatHistoryStore.ts';
import { commandRateLimiter, getRandomDelayMs } from '../utils/rateLimiter.ts';
import { formatDurationHuman } from '../utils/reminderStore.ts';
import { vipStore } from '../utils/vipStore.ts';
import {
  dispatchOpenGcProtectedPost,
  enforceAdvancedGroupGuards,
  enforceAntilink,
  enforceAntiScam,
  enforceAntiStatusMention,
  handleAntidelete,
} from './group.ts';

const AUTO_REACT_EMOJIS = ['❤️', '🔥', '👍', '😂', '😮', '✨', '💯', '🤩', '👏', '🥳'];

const processedMsgIds = new Set<string>();
const afkNoticeCooldown = new Map<string, number>();
const bannedNoticeCooldown = new Map<string, number>();

async function notifyIfMentionedAfk(
  sock: WASocket,
  msg: WAMessage,
  chatId: string,
  senderCandidates: string[]
): Promise<void> {
  if (msg.key.fromMe) return;
  const ctxInfo = extractContextInfo(msg.message);
  if (!ctxInfo) return;

  const targetJids = new Set<string>();
  if (Array.isArray(ctxInfo.mentionedJid)) {
    for (const j of ctxInfo.mentionedJid) {
      const bare = normalizeBareJid(j);
      if (bare) targetJids.add(bare);
    }
  }
  if (ctxInfo.participant) {
    const bare = normalizeBareJid(ctxInfo.participant);
    if (bare) targetJids.add(bare);
  }
  if (targetJids.size === 0) return;

  const senderParts = new Set(senderCandidates.map((c) => jidUserPart(c)));
  const botParts = new Set((await getBotJids(sock)).map((j) => jidUserPart(j)));

  for (const jid of targetJids) {
    const candidates = [jid];
    if (jid.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) candidates.push(normalizeBareJid(pn));
      } catch {
        // Ignore missing LID mapping
      }
    }
    if (candidates.some((c) => senderParts.has(jidUserPart(c)) || botParts.has(jidUserPart(c)))) {
      continue;
    }

    const afkEntry = vipStore.findAfkUser(candidates);
    if (!afkEntry) continue;

    const cdKey = `${chatId}:${afkEntry.number}`;
    const now = Date.now();
    if (now - (afkNoticeCooldown.get(cdKey) || 0) < 20_000) continue;
    afkNoticeCooldown.set(cdKey, now);
    if (afkNoticeCooldown.size > 400) {
      const oldest = afkNoticeCooldown.keys().next().value;
      if (oldest) afkNoticeCooldown.delete(oldest);
    }

    const mentionJid = afkEntry.jid || `${afkEntry.number}@s.whatsapp.net`;
    const awayDur = formatDurationHuman(Math.max(1000, now - afkEntry.since));
    await sock
      .sendMessage(
        chatId,
        {
          text: [
            `💤 *@${afkEntry.number} is currently AFK*`,
            `• Reason: ${afkEntry.reason || 'Away from keyboard'}`,
            `• Away for: ${awayDur}`,
          ].join('\n'),
          mentions: [mentionJid],
        },
        { quoted: msg }
      )
      .catch(() => {});
    break;
  }
}

function markProcessed(id: string | undefined | null): boolean {
  if (!id) return true;
  if (processedMsgIds.has(id)) return false;
  processedMsgIds.add(id);
  if (processedMsgIds.size > 600) {
    const first = processedMsgIds.values().next().value;
    if (first) processedMsgIds.delete(first);
  }
  return true;
}

export async function handleIncomingMessage(
  sock: WASocket,
  msg: WAMessage,
  getCachedMessage?: (chatId: string, msgId: string) => WAMessage | undefined
): Promise<void> {
  try {
    if (!msg.message || !msg.key?.remoteJid) return;
    const cfg = loadConfig();
    if (msg.key.remoteJid === 'status@broadcast') {
      if (!cfg.singleTick && cfg.autoStatusSeen && !msg.key.fromMe && msg.key.id) {
        void sock.readMessages([msg.key]).catch(() => {});
      }
      return;
    }

    // Handle antidelete revoke events before filtering body text
    if (msg.message.protocolMessage?.type === 0 && getCachedMessage) {
      await handleAntidelete(sock, msg, getCachedMessage);
      return;
    }

    if (!markProcessed(msg.key.id)) return;

    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');

    if (cfg.singleTick) {
      void sock.sendPresenceUpdate('unavailable').catch(() => {});
    } else {
      if (cfg.autoReadMessages && msg.key.id && !msg.key.fromMe) {
        void sock.readMessages([msg.key]).catch(() => {});
      }

      if (!msg.key.fromMe && (cfg.autoRecording || cfg.autoTyping)) {
        const mode = cfg.autoRecording ? 'recording' : 'composing';
        void sock.sendPresenceUpdate(mode, chatId).catch(() => {});
        const presenceTimer = setTimeout(() => {
          void sock.sendPresenceUpdate('paused', chatId).catch(() => {});
        }, 3200);
        if (typeof presenceTimer.unref === 'function') presenceTimer.unref();
      }
    }

    const { senderJid, senderCandidates, senderNumber } = await resolveSenderInfo(sock, msg);
    rememberUserName(senderJid, msg.pushName);
    rememberUserName(senderNumber, msg.pushName);
    const isOwner = Boolean(msg.key.fromMe) || vipStore.isOwner(senderNumber);
    const isVip = isOwner || vipStore.isVip(senderNumber);
    const bannedEntry = !isOwner
      ? vipStore.isUserBanned([senderNumber, senderJid, ...senderCandidates])
      : null;

    const body = extractBodyText(msg.message).trim();

    // Enforce group Anti-Status-Mention & Anti-Scam BEFORE empty-body exit
    if (isGroup) {
      const mentionBlocked = await enforceAntiStatusMention(
        sock,
        msg,
        body,
        chatId,
        senderCandidates,
        isOwner
      );
      if (mentionBlocked) return;

      const scamBlocked = await enforceAntiScam(
        sock,
        msg,
        body,
        chatId,
        senderCandidates,
        isOwner
      );
      if (scamBlocked) return;

      const advancedBlocked = await enforceAdvancedGroupGuards(
        sock,
        msg,
        chatId,
        senderCandidates,
        isOwner
      );
      if (advancedBlocked) return;
    }

    // Auto-React on incoming messages when enabled (disabled in Single Tick Shield & non-owner Private mode)
    if (
      cfg.autoReact &&
      !cfg.singleTick &&
      !msg.key.fromMe &&
      msg.key.id &&
      (cfg.mode !== 'self' || isOwner)
    ) {
      const emoji = AUTO_REACT_EMOJIS[Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)];
      void sock
        .sendMessage(chatId, {
          react: {
            text: emoji,
            key: msg.key,
          },
        })
        .catch(() => {});
    }

    if (!body) return;

    // Enforce group antilink before command parsing
    if (isGroup) {
      const blocked = await enforceAntilink(sock, msg, body, chatId, senderCandidates, isOwner);
      if (blocked) return;
    }

    const activePrefix = cfg.prefix;
    const supportedPrefixes = Array.from(new Set([activePrefix, '.', '/']));
    const matchedPrefix = supportedPrefixes.find((p) => body.startsWith(p));

    if (!msg.key.fromMe) {
      void notifyIfMentionedAfk(sock, msg, chatId, senderCandidates);
    }

    if (!matchedPrefix) {
      if (isGroup && body) {
        recordChatMessage(chatId, senderJid, msg.pushName || `+${senderNumber}`, body);
      }
      // If Owner has Auto-IB-Forward enabled and posts a non-command link/text inside the Bot's own IB,
      // dispatch it automatically to all Open GCs with Anti-Delete Lock!
      if (!isGroup && isOwner && cfg.autoForwardIbToOpenGcs) {
        const ownBotPhone = normalizePhone(jidUserPart(sock.user?.id));
        const chatPhone = normalizePhone(jidUserPart(chatId));
        const isOwnBotInbox =
          (ownBotPhone && chatPhone === ownBotPhone) ||
          (!msg.key.fromMe && senderNumber === normalizePhone(cfg.ownerNumber));
        if (isOwnBotInbox && !body.startsWith('*Protected Open-GC') && !body.startsWith('Delivered to ')) {
          const result = await dispatchOpenGcProtectedPost(sock, body);
          await sock
            .sendMessage(
              chatId,
              {
                text: `Delivered to *${result.sent}/${result.totalOpen}* Open Group(s) with Anti-Delete Lock.`,
              },
              { quoted: msg }
            )
            .catch(() => {});
          return;
        }
      }

      // AI Auto-Reply:
      // - In Groups: ONLY reply in groups where AI was explicitly turned ON (groupCfg.aiEnabled === true), and reply to every question/message!
      // - In Private DMs/IB: reply when global cfg.aiEnabled is ON.
      if (!msg.key.fromMe && !bannedEntry && (cfg.mode !== 'self' || isOwner)) {
        let shouldReplyWithAi = false;
        if (isGroup) {
          const groupCfg = vipStore.getGroupConfig(chatId);
          shouldReplyWithAi = Boolean(groupCfg.aiEnabled);
        } else {
          shouldReplyWithAi = Boolean(cfg.aiEnabled);
        }

        if (shouldReplyWithAi && body.trim().length > 0) {
          try {
            const replyText = await generateAiChatReply(body, msg.pushName || 'Friend');
            await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
          } catch (aiErr) {
            logger.error('ai', `AI auto-reply failed: ${(aiErr as Error).message}`);
          }
        }
      }
      return;
    }

    // Private Mode guard: strictly Owner ONLY (non-owners blocked from all bot commands)
    if (cfg.mode === 'self' && !isOwner) return;

    const withoutPrefix = body.slice(matchedPrefix.length).trim();
    if (!withoutPrefix) return;

    const parts = withoutPrefix.split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);
    const text = withoutPrefix.slice(cmdName.length).trim();

    const command = findCommand(cmdName);
    if (!command) return;

    if (bannedEntry) {
      const banKey = bannedEntry.number || senderNumber;
      const now = Date.now();
      if (now - (bannedNoticeCooldown.get(banKey) || 0) >= 60_000) {
        bannedNoticeCooldown.set(banKey, now);
        await sock
          .sendMessage(
            chatId,
            {
              text: `🚫 *Bot Access Denied:* You are banned from using bot commands.${bannedEntry.reason ? `\n• Reason: ${bannedEntry.reason}` : ''}`,
            },
            { quoted: msg }
          )
          .catch(() => {});
      }
      return;
    }

    // Permission checks
    if (command.ownerOnly && !isOwner) {
      await sock.sendMessage(
        chatId,
        { text: `Access Denied: \`${matchedPrefix}${command.name}\` is restricted to the Bot Owner.` },
        { quoted: msg }
      );
      return;
    }

    if (command.vipOnly && !isVip) {
      await sock.sendMessage(
        chatId,
        { text: `VIP Required: \`${matchedPrefix}${command.name}\` is restricted to authorized VIP users.` },
        { quoted: msg }
      );
      return;
    }

    if (command.groupOnly && !isGroup) {
      await sock.sendMessage(
        chatId,
        { text: `Group Only: \`${matchedPrefix}${command.name}\` can only be used inside WhatsApp groups.` },
        { quoted: msg }
      );
      return;
    }

    // Per-user and per-group anti-spam command cooldowns
    if (!isOwner) {
      const userCooldownSec = Math.max(cfg.cmdCooldownSeconds, command.cooldownSeconds || 0);
      const userCd = commandRateLimiter.checkCooldown(
        `cmd-user:${senderNumber}:${command.name}`,
        userCooldownSec
      );
      if (!userCd.allowed) {
        if (userCd.hitCount >= 3) {
          logger.warn(
            'safetyGuard',
            `Command flood warning: +${senderNumber} repeatedly hit cooldown on ${matchedPrefix}${command.name} (${userCd.hitCount}x)`
          );
        }
        await sock.sendMessage(
          chatId,
          { text: `Slow down: wait ${userCd.retryAfterSeconds}s before running \`${matchedPrefix}${command.name}\` again.` },
          { quoted: msg }
        );
        return;
      }

      if (isGroup && cfg.groupCmdCooldownSeconds > 0) {
        const groupCd = commandRateLimiter.checkCooldown(
          `cmd-group:${chatId}`,
          cfg.groupCmdCooldownSeconds
        );
        if (!groupCd.allowed) {
          if (groupCd.hitCount >= 4) {
            logger.warn(
              'safetyGuard',
              `Group command flood warning in ${chatId} (${groupCd.hitCount} rapid triggers)`
            );
          }
          return;
        }
      }
    }

    const ctx: CommandContext = {
      sock,
      msg,
      chatId,
      senderJid,
      senderCandidates,
      senderNumber,
      pushName: msg.pushName || 'WhatsApp User',
      isGroup,
      isOwner,
      isVip,
      prefix: matchedPrefix,
      commandName: command.name,
      args,
      text,
      isSimulated: false,
      reply: async (replyText: string) => {
        await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });
      },
      sendText: async (jid: string, messageText: string) => {
        await sock.sendMessage(jid, { text: messageText });
      },
      getCachedMessage,
    };

    logger.cmd('messageHandler', `${matchedPrefix}${command.name} from +${senderNumber}`);
    try {
      if (cfg.humanDelayEnabled && cfg.humanDelayMaxMs > 0) {
        if (!cfg.singleTick) {
          const presenceMode = command.name === 'tts' ? 'recording' : 'composing';
          void sock.sendPresenceUpdate(presenceMode, chatId).catch(() => {});
        }
        const paceMs = getRandomDelayMs(cfg.humanDelayMinMs, cfg.humanDelayMaxMs);
        if (paceMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, paceMs));
        }
      }
      await command.execute(ctx);
      if (cfg.humanDelayEnabled && !cfg.singleTick) {
        void sock.sendPresenceUpdate('paused', chatId).catch(() => {});
      }
    } catch (cmdErr) {
      const errText = (cmdErr as Error).message || 'Unexpected error';
      logger.error('messageHandler', `Command ${matchedPrefix}${command.name} failed: ${errText}`);
      await sock
        .sendMessage(chatId, { text: `Command error (${matchedPrefix}${command.name}): ${errText}` }, { quoted: msg })
        .catch(() => {});
    }
  } catch (err) {
    logger.error('messageHandler', `Unhandled command error: ${(err as Error).message}`);
  }
}

export async function executeConsoleCommand(
  rawInput: string,
  senderNumber?: string
): Promise<{ ok: boolean; output: string; command?: string }> {
  try {
    const cfg = loadConfig();
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return { ok: false, output: 'Enter a command (example: .menu or .ping).' };
    }

    const prefixes = Array.from(new Set([cfg.prefix, '.', '/']));
    const matchedPrefix = prefixes.find((p) => trimmed.startsWith(p)) || '';
    const withoutPrefix = matchedPrefix ? trimmed.slice(matchedPrefix.length).trim() : trimmed;
    const parts = withoutPrefix.split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);
    const text = withoutPrefix.slice(cmdName.length).trim();

    const command = findCommand(cmdName);
    if (!command) {
      return {
        ok: false,
        output: `Unknown command "${cmdName}". Type ${cfg.prefix}menu to see all supported commands.`,
      };
    }

    const effectiveNumber = normalizePhone(senderNumber || cfg.ownerNumber);
    const isOwner = vipStore.isOwner(effectiveNumber);
    const isVip = isOwner || vipStore.isVip(effectiveNumber);

    const consoleBanned = !isOwner ? vipStore.isUserBanned([effectiveNumber]) : null;
    if (consoleBanned) {
      return {
        ok: false,
        output: `Access Denied: User +${effectiveNumber} is banned from using bot commands.${consoleBanned.reason ? ` Reason: ${consoleBanned.reason}` : ''}`,
      };
    }

    if (command.ownerOnly && !isOwner) {
      return { ok: false, output: `Access Denied: ${command.name} requires Owner privileges.` };
    }

    const replies: string[] = [];
    const ctx: CommandContext = {
      sock: null,
      msg: null,
      chatId: `${effectiveNumber}@s.whatsapp.net`,
      senderJid: `${effectiveNumber}@s.whatsapp.net`,
      senderCandidates: [`${effectiveNumber}@s.whatsapp.net`],
      senderNumber: effectiveNumber,
      pushName: isOwner ? cfg.ownerName : 'Console Operator',
      isGroup: command.groupOnly ? true : false,
      isOwner,
      isVip,
      prefix: matchedPrefix || cfg.prefix,
      commandName: command.name,
      args,
      text,
      isSimulated: true,
      reply: async (txt: string) => {
        replies.push(txt);
      },
      sendText: async (_jid: string, txt: string) => {
        replies.push(txt);
      },
    };

    logger.cmd('console', `Executed ${ctx.prefix}${command.name} as +${effectiveNumber}`);
    const result = await command.execute(ctx);
    const output = replies.join('\n\n') || result || 'Command executed.';
    return { ok: true, output, command: command.name };
  } catch (err) {
    logger.error('console', `Console command error: ${(err as Error).message}`);
    return { ok: false, output: `Error: ${(err as Error).message}` };
  }
}
