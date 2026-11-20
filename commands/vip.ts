import { isValidPhone, loadConfig, normalizePhone } from '../config/bot.config.ts';
import { logger } from '../utils/logger.ts';
import { pairingRateLimiter } from '../utils/rateLimiter.ts';
import { vipStore, type VipTier } from '../utils/vipStore.ts';
import type { BotCommand } from './types.ts';

export const vipCommands: BotCommand[] = [
  {
    name: 'pair',
    aliases: ['pairing', 'code'],
    category: 'vip',
    description: 'VIP 8-digit pairing code generate kare (VIP gate + rate-limit)',
    usage: 'pair <number> [vipToken]',
    cooldownSeconds: 5,
    execute: async (ctx) => {
      const cfg = loadConfig();
      const targetRaw = ctx.args[0] || ctx.senderNumber;
      const targetPhone = normalizePhone(targetRaw);
      const tokenArg = ctx.args[1];

      if (!isValidPhone(targetPhone)) {
        const msg = `Invalid phone number.\nUsage: \`${ctx.prefix}pair 923001234567\``;
        await ctx.reply(msg);
        return msg;
      }

      const cooldown = pairingRateLimiter.checkCooldown(
        `wa-pair-cd:${targetPhone}`,
        cfg.pairCooldownSeconds
      );
      if (!cooldown.allowed) {
        logger.warn(
          'safetyGuard',
          `Pairing cooldown triggered for +${targetPhone} (${cooldown.retryAfterSeconds}s remaining)`
        );
        const msg = `Pairing cooldown active for +${targetPhone}. Wait ${cooldown.retryAfterSeconds} seconds before requesting another code.`;
        await ctx.reply(msg);
        return msg;
      }

      const rate = pairingRateLimiter.check(
        `wa:${targetPhone}`,
        cfg.maxPairAttempts,
        cfg.pairWindowMinutes
      );
      if (!rate.allowed) {
        vipStore.logPairingAttempt({
          number: targetPhone,
          status: 'rate_limited',
          reason: `Rate limit exceeded. Retry in ${rate.retryAfterSeconds}s`,
          source: 'whatsapp_cmd',
        });
        logger.security(
          'safetyGuard',
          `WhatsApp pairing rate limit exceeded for +${targetPhone} (blocked ${rate.retryAfterSeconds}s)`
        );
        const msg = `Rate limit exceeded for +${targetPhone}. Try again in ${rate.retryAfterSeconds} seconds.`;
        await ctx.reply(msg);
        return msg;
      }

      if (rate.remaining <= 1) {
        logger.warn(
          'safetyGuard',
          `Pairing limit warning: +${targetPhone} has ${rate.remaining} attempt(s) left in ${cfg.pairWindowMinutes}m window.`
        );
      }

      const auth = vipStore.isAuthorizedForPairing(targetPhone, tokenArg);
      const requesterAuthorized = ctx.isOwner || ctx.isVip;

      if (cfg.vipOnlyPairing && !auth.authorized && !requesterAuthorized) {
        vipStore.logPairingAttempt({
          number: targetPhone,
          status: 'denied',
          reason: auth.reason,
          source: 'whatsapp_cmd',
        });
        const msg = [
          `*VIP Access Required*`,
          `Number +${targetPhone} is not authorized for ${cfg.botName} pairing.`,
          `Contact Owner (+${cfg.ownerNumber}) to activate VIP access.`,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      const { requestVipSubPairingCode } = await import('../handlers/connection.ts');
      const result = await requestVipSubPairingCode(targetPhone, 'whatsapp_cmd');
      if (!result.success || !result.code) {
        const msg = `Pairing failed: ${result.error || 'Unable to generate code right now.'}`;
        await ctx.reply(msg);
        return msg;
      }

      const msg = [
        `*${cfg.botName} VIP Pairing Code*`,
        `• Target Number: +${targetPhone}`,
        `• 8-Digit Code: \`${result.code}\``,
        `• Session Scope: ${result.sessionId}`,
        '',
        'Open WhatsApp > Linked Devices > Link with phone number instead, and enter this code.',
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'addvip',
    aliases: ['vipadd'],
    category: 'vip',
    description: 'Owner VIP access aur unique VIP token add kare',
    usage: 'addvip <number> [diamond|gold] [name]',
    ownerOnly: true,
    execute: async (ctx) => {
      const rawNumber = ctx.args[0];
      const cleaned = normalizePhone(rawNumber || '');
      if (!isValidPhone(cleaned)) {
        const msg = `Provide a valid phone number with country code.\nExample: \`${ctx.prefix}addvip 923001234567 diamond Ali\``;
        await ctx.reply(msg);
        return msg;
      }

      const maybeTier = ctx.args[1]?.toLowerCase();
      const tier: VipTier = maybeTier === 'diamond' || maybeTier === 'gold' ? maybeTier : 'gold';
      const nameParts = maybeTier === 'diamond' || maybeTier === 'gold' ? ctx.args.slice(2) : ctx.args.slice(1);
      const name = nameParts.join(' ').trim() || undefined;

      const added = vipStore.addVip({
        number: cleaned,
        tier,
        name,
        addedBy: ctx.senderNumber,
      });

      const msg = [
        `*VIP Access Granted*`,
        `• Number: +${added.number}`,
        `• Name: ${added.name}`,
        `• Tier: ${added.tier.toUpperCase()}`,
        `• VIP Token: \`${added.token}\``,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'delvip',
    aliases: ['rmvip', 'removevip'],
    category: 'vip',
    description: 'Owner VIP access list se number remove kare',
    usage: 'delvip <number>',
    ownerOnly: true,
    execute: async (ctx) => {
      const cleaned = normalizePhone(ctx.args[0] || '');
      if (!isValidPhone(cleaned)) {
        const msg = `Usage: \`${ctx.prefix}delvip 923001234567\``;
        await ctx.reply(msg);
        return msg;
      }

      const res = vipStore.removeVip(cleaned);
      const msg = res.removed
        ? `Removed +${cleaned} from ${loadConfig().botName} VIP whitelist.`
        : `Could not remove +${cleaned}: ${res.reason}`;
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'viplist',
    aliases: ['vips'],
    category: 'vip',
    description: 'Active VIP numbers aur tiers ki list show kare',
    usage: 'viplist',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const vips = vipStore.listVips().filter((v) => v.active);
      if (vips.length === 0) {
        const msg = 'No active VIP users registered.';
        await ctx.reply(msg);
        return msg;
      }
      const lines = [
        `*${loadConfig().botName} — Active VIP Registry (${vips.length})*`,
        '',
        ...vips.map(
          (v, idx) =>
            `${idx + 1}. +${v.number} — *${v.name}* [${v.tier.toUpperCase()}] (Pairs: ${v.pairingCount})`
        ),
      ];
      const msg = lines.join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
  {
    name: 'checkvip',
    aliases: ['myvip', 'vipstatus'],
    category: 'vip',
    description: 'User apna VIP status aur pairing eligibility check kare',
    usage: 'checkvip [number]',
    cooldownSeconds: 3,
    execute: async (ctx) => {
      const target = normalizePhone(ctx.args[0] || ctx.senderNumber);
      const found = vipStore.findVip(target);
      if (!found) {
        const msg = [
          `*VIP Status: Standard User*`,
          `• Number: +${target}`,
          `• Pairing Access: Restricted (Not Whitelisted)`,
          `• Tip: Ask Owner (+${loadConfig().ownerNumber}) for \`${ctx.prefix}addvip\`.`,
        ].join('\n');
        await ctx.reply(msg);
        return msg;
      }

      const msg = [
        `*VIP Status: Active*`,
        `• Number: +${found.number}`,
        `• Name: ${found.name}`,
        `• Tier: ${found.tier.toUpperCase()}`,
        `• Total Pairings: ${found.pairingCount}`,
        `• Added: ${found.addedAt.slice(0, 10)}`,
      ].join('\n');
      await ctx.reply(msg);
      return msg;
    },
  },
];
