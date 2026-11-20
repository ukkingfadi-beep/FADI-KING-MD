import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import { findCommand } from '../commands/index.ts';
import type { CommandContext } from '../commands/types.ts';
import { extractBodyText, resolveSenderInfo } from '../utils/jidHelper.ts';
import { logger } from '../utils/logger.ts';
import { commandRateLimiter, getRandomDelayMs } from '../utils/rateLimiter.ts';
import { vipStore } from '../utils/vipStore.ts';
import { enforceAntilink, handleAntidelete } from './group.ts';

const processedMsgIds = new Set<string>();

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
    if (msg.key.remoteJid === 'status@broadcast') {
      if (loadConfig().autoStatusSeen && !msg.key.fromMe && msg.key.id) {
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

    const cfg = loadConfig();
    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');

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

    const { senderJid, senderCandidates, senderNumber } = await resolveSenderInfo(sock, msg);
    const isOwner = Boolean(msg.key.fromMe) || vipStore.isOwner(senderNumber);
    const isVip = isOwner || vipStore.isVip(senderNumber);

    const body = extractBodyText(msg.message).trim();
    if (!body) return;

    // Enforce group antilink before command parsing
    if (isGroup) {
      const blocked = await enforceAntilink(sock, msg, body, chatId, senderCandidates, isOwner);
      if (blocked) return;
    }

    const activePrefix = cfg.prefix;
    const supportedPrefixes = Array.from(new Set([activePrefix, '.', '/']));
    const matchedPrefix = supportedPrefixes.find((p) => body.startsWith(p));
    if (!matchedPrefix) return;

    // Mode guard: self mode allows only Owner or VIPs
    if (cfg.mode === 'self' && !isOwner && !isVip) return;

    const withoutPrefix = body.slice(matchedPrefix.length).trim();
    if (!withoutPrefix) return;

    const parts = withoutPrefix.split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);
    const text = withoutPrefix.slice(cmdName.length).trim();

    const command = findCommand(cmdName);
    if (!command) return;

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
        const presenceMode = command.name === 'tts' ? 'recording' : 'composing';
        void sock.sendPresenceUpdate(presenceMode, chatId).catch(() => {});
        const paceMs = getRandomDelayMs(cfg.humanDelayMinMs, cfg.humanDelayMaxMs);
        if (paceMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, paceMs));
        }
      }
      await command.execute(ctx);
      if (cfg.humanDelayEnabled) {
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
