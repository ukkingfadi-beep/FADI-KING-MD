import type { proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { loadConfig, normalizePhone } from '../config/bot.config.ts';
import { anticallStore } from './anticallStore.ts';
import { dbGetSync, dbSetSync, registerDbHydrationHook } from './db.ts';
import {
  findParticipant,
  getBotJids,
  getCachedGroupMetadata,
  invalidateGroupMetadataCache,
  isLidUser,
  isParticipantAdmin,
  jidUserPart,
  normalizeBareJid,
  resolveSenderInfo,
} from './jidHelper.ts';
import { logger } from './logger.ts';
import { vipStore } from './vipStore.ts';

export type ThreatCategory =
  | 'ZERO_WIDTH_CRASH'
  | 'BIDI_OVERRIDE_BOMB'
  | 'ZALGO_RENDER_HANG'
  | 'PROTO_DEPTH_OVERFLOW'
  | 'MASS_MENTION_CRASH'
  | 'NATIVE_FLOW_EXPLOIT'
  | 'VCARD_BOMB'
  | 'TEXT_BOMB_EXPLOIT'
  | 'MALICIOUS_SCRIPT_PAYLOAD'
  | 'MALFORMED_PROTOCOL_BUFFER'
  | 'HEURISTIC_FLOOD_EXPLOIT';

export interface ThreatInspectionResult {
  isThreat: boolean;
  severity: 'none' | 'medium' | 'high' | 'critical';
  score: number;
  categories: ThreatCategory[];
  reasons: string[];
  metrics: {
    depth: number;
    nodeCount: number;
    totalTextBytes: number;
    invisibleCount: number;
    bidiCount: number;
    combiningCount: number;
    mentionedCount: number;
  };
}

export interface VirusBlacklistEntry {
  jid: string;
  number: string;
  categories: ThreatCategory[];
  reason: string;
  chatId: string;
  blockedAt: string;
  hits: number;
}

export interface ThreatIncidentEntry {
  id: string;
  attackerJid: string;
  attackerNumber: string;
  chatId: string;
  scope: 'owner_ib' | 'vip_ib' | 'dm' | 'group';
  categories: ThreatCategory[];
  reason: string;
  actionTaken: string;
  timestamp: string;
}

const MAX_TRAVERSAL_DEPTH = 15;
const MAX_TRAVERSAL_NODES = 2400;
const WRAPPER_DEPTH_LIMIT = 10;

const WRAPPER_KEYS = new Set([
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'editedMessage',
  'associatedChildMessage',
  'botInvokeMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
  'groupStatusMentionMessage',
  'statusMentionMessage',
]);

// Invisible / non-rendered / formatting control characters (excluding normal single ZWJ emoji usage)
const CONSECUTIVE_INVISIBLE_REGEX =
  /[\u200B-\u200F\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E\u2800]{8,}/;
const ALL_INVISIBLE_REGEX =
  /[\u200B-\u200C\u200E-\u200F\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E\u2800]/g;
const ZWJ_ONLY_REGEX = /\u200D/g;
const SUPPLEMENTAL_TAG_FLOOD_REGEX = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]{6,}/u;

// Bidirectional text override / isolate attack sequences
const CONSECUTIVE_BIDI_REGEX = /[\u202A-\u202E\u2066-\u2069]{5,}/;
const ALL_BIDI_REGEX = /[\u202A-\u202E\u2066-\u2069]/g;

// Combining diacritical mark floods (Zalgo / rendering hang)
const CONSECUTIVE_COMBINING_REGEX =
  /[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u0610-\u061A\u064B-\u065F\u06D6-\u06ED\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]{8,}/;
const ALL_COMBINING_REGEX =
  /[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u0610-\u061A\u064B-\u065F\u06D6-\u06ED\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;

// Script / DOM / JSON prototype pollution payloads
const MALICIOUS_SCRIPT_REGEX =
  /(?:<script\b[^>]*>[\s\S]*?<\/script>|javascript\s*:\s*[a-zA-Z_$(\[]|data\s*:\s*text\/html\s*[;,]|(?:\bonerror|\bonload|\bonmouseover|\bonfocus)\s*=\s*['"][^'"]{2,}|__proto__|constructor\s*(?:\.\s*prototype|\[\s*['"]prototype['"]\s*\]))/i;

let blacklistCache: VirusBlacklistEntry[] | null = null;
let incidentsCache: ThreatIncidentEntry[] | null = null;

registerDbHydrationHook(() => {
  blacklistCache = null;
  incidentsCache = null;
});

const processedThreatIds = new Set<string>();
const heuristicWindowMap = new Map<string, { timestamps: number[]; scoreSum: number }>();
const alertNoticeCooldown = new Map<string, number>();

function markThreatHandledOnce(msgId: string | undefined | null): boolean {
  if (!msgId) return true;
  if (processedThreatIds.has(msgId)) return false;
  processedThreatIds.add(msgId);
  if (processedThreatIds.size > 1200) {
    const first = processedThreatIds.values().next().value;
    if (first) processedThreatIds.delete(first);
  }
  return true;
}

function measureMaxJsonDepth(raw: string, limit = 24): number {
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let escaped = false;
  const maxScan = Math.min(raw.length, 30_000);
  for (let i = 0; i < maxScan; i += 1) {
    const ch = raw[i];
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
      if (ch === '{' || ch === '[') {
        depth += 1;
        if (depth > maxDepth) maxDepth = depth;
        if (maxDepth >= limit) return maxDepth;
      } else if (ch === '}' || ch === ']') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return maxDepth;
}

export function inspectMessagePayload(
  message: proto.IMessage | null | undefined,
  senderTrackKey?: string
): ThreatInspectionResult {
  const categories = new Set<ThreatCategory>();
  const reasons = new Set<string>();
  let score = 0;

  const metrics = {
    depth: 0,
    nodeCount: 0,
    totalTextBytes: 0,
    invisibleCount: 0,
    bidiCount: 0,
    combiningCount: 0,
    mentionedCount: 0,
  };

  if (!message || typeof message !== 'object') {
    return {
      isThreat: false,
      severity: 'none',
      score: 0,
      categories: [],
      reasons: [],
      metrics,
    };
  }

  const visited = new WeakSet<object>();
  const stack: Array<{
    node: unknown;
    depth: number;
    wrapperDepth: number;
    keyPath: string;
  }> = [{ node: message, depth: 0, wrapperDepth: 0, keyPath: 'root' }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    metrics.nodeCount += 1;
    if (current.depth > metrics.depth) metrics.depth = current.depth;

    if (metrics.nodeCount > MAX_TRAVERSAL_NODES) {
      categories.add('PROTO_DEPTH_OVERFLOW');
      reasons.add(`Protobuf node flood (>${MAX_TRAVERSAL_NODES} nodes)`);
      score += 90;
      break;
    }

    if (current.wrapperDepth >= WRAPPER_DEPTH_LIMIT) {
      categories.add('PROTO_DEPTH_OVERFLOW');
      reasons.add(`Excessive message wrapper nesting (${current.wrapperDepth} layers)`);
      score += 90;
      break;
    }

    if (current.depth > MAX_TRAVERSAL_DEPTH) {
      categories.add('PROTO_DEPTH_OVERFLOW');
      reasons.add(`Protobuf structure depth exceeded ${MAX_TRAVERSAL_DEPTH} levels`);
      score += 80;
      continue;
    }

    const val = current.node;
    if (val === null || val === undefined) continue;

    if (typeof val === 'string') {
      metrics.totalTextBytes += val.length;
      const lowerPath = current.keyPath.toLowerCase();

      // Skip huge base64 data fields only if they are small; flag truly massive raw string payloads
      if (val.length > 15_000) {
        categories.add('TEXT_BOMB_EXPLOIT');
        reasons.add(`Oversized string payload (${val.length} chars at ${current.keyPath})`);
        score += 80;
      }

      if (CONSECUTIVE_INVISIBLE_REGEX.test(val) || SUPPLEMENTAL_TAG_FLOOD_REGEX.test(val)) {
        categories.add('ZERO_WIDTH_CRASH');
        reasons.add(`Consecutive invisible/zero-width flood in ${current.keyPath}`);
        score += 85;
      }

      const invMatches = val.match(ALL_INVISIBLE_REGEX);
      const invCount = invMatches ? invMatches.length : 0;
      const zwjMatches = val.match(ZWJ_ONLY_REGEX);
      const zwjCount = zwjMatches ? zwjMatches.length : 0;
      metrics.invisibleCount += invCount + zwjCount;

      if (invCount >= 25 || zwjCount >= 45) {
        categories.add('ZERO_WIDTH_CRASH');
        reasons.add(`High-density invisible unicode sequence (${invCount + zwjCount} chars)`);
        score += 75;
      }

      if (CONSECUTIVE_BIDI_REGEX.test(val)) {
        categories.add('BIDI_OVERRIDE_BOMB');
        reasons.add(`Bidirectional override bomb in ${current.keyPath}`);
        score += 80;
      }
      const bidiMatches = val.match(ALL_BIDI_REGEX);
      const bidiCount = bidiMatches ? bidiMatches.length : 0;
      metrics.bidiCount += bidiCount;
      if (bidiCount >= 10 || (lowerPath.endsWith('filename') && bidiCount >= 1)) {
        categories.add('BIDI_OVERRIDE_BOMB');
        reasons.add(
          lowerPath.endsWith('filename')
            ? 'RTLO/Bidi spoofing detected in document filename'
            : `Bidirectional override flood (${bidiCount} chars)`
        );
        score += 75;
      }

      if (CONSECUTIVE_COMBINING_REGEX.test(val)) {
        categories.add('ZALGO_RENDER_HANG');
        reasons.add(`Stacked combining-diacritic (Zalgo) sequence in ${current.keyPath}`);
        score += 80;
      }
      const combMatches = val.match(ALL_COMBINING_REGEX);
      const combCount = combMatches ? combMatches.length : 0;
      metrics.combiningCount += combCount;
      if (combCount >= 80) {
        categories.add('ZALGO_RENDER_HANG');
        reasons.add(`Excessive combining diacritics (${combCount} marks)`);
        score += 75;
      }

      if (MALICIOUS_SCRIPT_REGEX.test(val)) {
        categories.add('MALICIOUS_SCRIPT_PAYLOAD');
        reasons.add(`Malicious script / prototype injection pattern in ${current.keyPath}`);
        score += 75;
      }

      if (lowerPath.endsWith('buttonparamsjson')) {
        if (val.length > 10_000 || measureMaxJsonDepth(val) >= 18) {
          categories.add('NATIVE_FLOW_EXPLOIT');
          reasons.add('Oversized or deeply nested nativeFlow buttonParamsJson');
          score += 85;
        } else if (val.length > 1500) {
          try {
            JSON.parse(val);
          } catch {
            categories.add('NATIVE_FLOW_EXPLOIT');
            reasons.add('Malformed oversized JSON inside nativeFlow buttonParamsJson');
            score += 75;
          }
        }
      }

      if (lowerPath.endsWith('.vcard') || lowerPath === 'vcard') {
        const lineCount = val.split('\n').length;
        if (val.length > 12_000 || lineCount > 140) {
          categories.add('VCARD_BOMB');
          reasons.add(`Oversized vCard bomb (${val.length} bytes, ${lineCount} lines)`);
          score += 85;
        }
      }

      continue;
    }

    if (typeof val === 'number') {
      const lowerPath = current.keyPath.toLowerCase();
      if (
        (lowerPath.endsWith('.seconds') && (val < 0 || val > 604_800)) ||
        (lowerPath.endsWith('.pagecount') && (val < 0 || val > 50_000)) ||
        (lowerPath.endsWith('.filelength') && (val < 0 || val > 5_000_000_000))
      ) {
        categories.add('MALFORMED_PROTOCOL_BUFFER');
        reasons.add(`Out-of-bounds protocol buffer numeric field (${current.keyPath}=${val})`);
        score += 65;
      }
      continue;
    }

    if (typeof val !== 'object') continue;

    // Binary buffers (e.g. jpegThumbnail, pngThumbnail, fileSha256)
    if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
      const lowerPath = current.keyPath.toLowerCase();
      if (lowerPath.includes('thumbnail') && val.byteLength > 300_000) {
        categories.add('MALFORMED_PROTOCOL_BUFFER');
        reasons.add(`Oversized inline thumbnail buffer (${Math.round(val.byteLength / 1024)} KB)`);
        score += 75;
      }
      continue;
    }

    if (visited.has(val)) {
      categories.add('MALFORMED_PROTOCOL_BUFFER');
      reasons.add('Cyclic protocol buffer object reference');
      score += 90;
      continue;
    }
    visited.add(val);

    if (Array.isArray(val)) {
      const lowerPath = current.keyPath.toLowerCase();
      if (lowerPath.endsWith('mentionedjid')) {
        metrics.mentionedCount += val.length;
        const malformedCount = val.filter(
          (item) => typeof item !== 'string' || !item.includes('@') || item.length > 100
        ).length;
        const uniqueCount = new Set(val.map((v) => String(v))).size;
        const duplicateFlood = val.length - uniqueCount >= 20;

        if (val.length >= 80 || malformedCount >= 5 || duplicateFlood) {
          categories.add('MASS_MENTION_CRASH');
          reasons.add(
            `Mass/malformed mention payload (${val.length} mentions, ${malformedCount} malformed)`
          );
          score += 80;
        }
      } else if (lowerPath.endsWith('.buttons') && val.length > 25) {
        categories.add('NATIVE_FLOW_EXPLOIT');
        reasons.add(`Interactive button flood (${val.length} buttons)`);
        score += 85;
      } else if (lowerPath.endsWith('.sections') && val.length > 25) {
        categories.add('MALFORMED_PROTOCOL_BUFFER');
        reasons.add(`Oversized listMessage sections (${val.length})`);
        score += 85;
      } else if (lowerPath.endsWith('.options') && val.length > 25) {
        categories.add('MALFORMED_PROTOCOL_BUFFER');
        reasons.add(`Oversized poll options (${val.length})`);
        score += 80;
      } else if (lowerPath.endsWith('.contacts') && val.length > 35) {
        categories.add('VCARD_BOMB');
        reasons.add(`Oversized contacts array bomb (${val.length} contacts)`);
        score += 85;
      }

      const limit = Math.min(val.length, 250);
      for (let i = 0; i < limit; i += 1) {
        stack.push({
          node: val[i],
          depth: current.depth + 1,
          wrapperDepth: current.wrapperDepth,
          keyPath: `${current.keyPath}[${i}]`,
        });
      }
      continue;
    }

    let entries: Array<[string, unknown]>;
    try {
      entries = Object.entries(val as Record<string, unknown>);
    } catch {
      categories.add('MALFORMED_PROTOCOL_BUFFER');
      reasons.add(`Unreadable protocol node at ${current.keyPath}`);
      score += 85;
      continue;
    }

    for (const [k, v] of entries) {
      if (v === undefined || v === null) continue;
      const nextWrapper = WRAPPER_KEYS.has(k) ? current.wrapperDepth + 1 : current.wrapperDepth;
      stack.push({
        node: v,
        depth: current.depth + 1,
        wrapperDepth: nextWrapper,
        keyPath: current.keyPath === 'root' ? k : `${current.keyPath}.${k}`,
      });
    }
  }

  if (metrics.totalTextBytes > 35_000) {
    categories.add('TEXT_BOMB_EXPLOIT');
    reasons.add(`Cumulative message payload exceeded 35 KB (${metrics.totalTextBytes} chars)`);
    score += 80;
  }

  // Heuristic behavioral monitoring for repeated borderline/anomalous bursts
  if (senderTrackKey && score >= 25 && score < 60) {
    const now = Date.now();
    const rec = heuristicWindowMap.get(senderTrackKey) || { timestamps: [], scoreSum: 0 };
    rec.timestamps = rec.timestamps.filter((ts) => now - ts < 10_000);
    rec.timestamps.push(now);
    rec.scoreSum += score;
    heuristicWindowMap.set(senderTrackKey, rec);
    if (heuristicWindowMap.size > 3000) {
      const oldest = heuristicWindowMap.keys().next().value;
      if (oldest) heuristicWindowMap.delete(oldest);
    }
    if (rec.timestamps.length >= 3 || rec.scoreSum >= 90) {
      categories.add('HEURISTIC_FLOOD_EXPLOIT');
      reasons.add('Repeated anomalous exploit probes within 10s window');
      score = Math.max(score, 75);
    }
  }

  const isThreat = score >= 60;
  const severity: ThreatInspectionResult['severity'] =
    score >= 85 ? 'critical' : score >= 60 ? 'high' : score >= 30 ? 'medium' : 'none';

  return {
    isThreat,
    severity,
    score,
    categories: Array.from(categories),
    reasons: Array.from(reasons),
    metrics,
  };
}

export function sanitizeMessageInPlace(msg: WAMessage): void {
  try {
    if (msg && typeof msg === 'object') {
      msg.message = {
        conversation: '[NEUTRALIZED ANTI-VIRUS PAYLOAD]',
      };
    }
  } catch {
    // Ignore immutable proxy errors
  }
}

export const crashGuardStore = {
  listBlacklist(): VirusBlacklistEntry[] {
    if (!blacklistCache) {
      const fromDb = dbGetSync<VirusBlacklistEntry[]>('virus_blacklist') || [];
      blacklistCache = Array.isArray(fromDb) ? fromDb : [];
    }
    return [...blacklistCache];
  },

  listIncidents(limit = 50): ThreatIncidentEntry[] {
    if (!incidentsCache) {
      const fromDb = dbGetSync<ThreatIncidentEntry[]>('virus_incidents') || [];
      incidentsCache = Array.isArray(fromDb) ? fromDb : [];
    }
    return incidentsCache.slice(0, limit);
  },

  isBlacklisted(candidates: string[]): VirusBlacklistEntry | null {
    const list = this.listBlacklist();
    if (list.length === 0) return null;
    for (const raw of candidates) {
      if (!raw) continue;
      const bare = normalizeBareJid(raw);
      const user = jidUserPart(bare);
      const clean = normalizePhone(user);
      const hit = list.find(
        (entry) =>
          (clean && entry.number === clean) ||
          (user && jidUserPart(entry.jid) === user) ||
          (bare && entry.jid === bare)
      );
      if (hit) return hit;
    }
    return null;
  },

  recordBlacklistedAttacker(input: {
    jid: string;
    number?: string;
    categories: ThreatCategory[];
    reason: string;
    chatId: string;
  }): VirusBlacklistEntry {
    const bare = normalizeBareJid(input.jid) || input.jid;
    const cleanNum =
      normalizePhone(input.number || jidUserPart(bare)) || jidUserPart(bare);
    const list = this.listBlacklist();
    const existingIdx = list.findIndex(
      (e) =>
        (cleanNum && e.number === cleanNum) ||
        (bare && e.jid === bare)
    );

    if (existingIdx >= 0) {
      const prev = list[existingIdx];
      const mergedCats = Array.from(new Set([...prev.categories, ...input.categories]));
      const updated: VirusBlacklistEntry = {
        ...prev,
        jid: bare.endsWith('@s.whatsapp.net') ? bare : prev.jid || bare,
        number: cleanNum || prev.number,
        categories: mergedCats,
        reason: input.reason || prev.reason,
        chatId: input.chatId || prev.chatId,
        hits: (prev.hits || 1) + 1,
      };
      list[existingIdx] = updated;
      blacklistCache = list;
      dbSetSync('virus_blacklist', list);
      return updated;
    }

    const created: VirusBlacklistEntry = {
      jid: bare,
      number: cleanNum,
      categories: input.categories,
      reason: input.reason,
      chatId: input.chatId,
      blockedAt: new Date().toISOString(),
      hits: 1,
    };
    list.unshift(created);
    if (list.length > 1000) list.length = 1000;
    blacklistCache = list;
    dbSetSync('virus_blacklist', list);
    return created;
  },

  removeFromBlacklist(candidates: string[]): VirusBlacklistEntry | null {
    const hit = this.isBlacklisted(candidates);
    if (!hit) return null;
    const list = this.listBlacklist().filter(
      (e) => e.number !== hit.number && e.jid !== hit.jid
    );
    blacklistCache = list;
    dbSetSync('virus_blacklist', list);
    return hit;
  },

  logIncident(entry: Omit<ThreatIncidentEntry, 'id' | 'timestamp'>): ThreatIncidentEntry {
    const list = this.listIncidents(200);
    const created: ThreatIncidentEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    list.unshift(created);
    if (list.length > 200) list.length = 200;
    incidentsCache = list;
    dbSetSync('virus_incidents', list);
    return created;
  },
};

function canNotifyCooldown(key: string, windowMs = 15_000): boolean {
  const now = Date.now();
  const prev = alertNoticeCooldown.get(key) || 0;
  if (now - prev < windowMs) return false;
  alertNoticeCooldown.set(key, now);
  if (alertNoticeCooldown.size > 2000) {
    for (const [k, ts] of alertNoticeCooldown.entries()) {
      if (now - ts > 60_000) alertNoticeCooldown.delete(k);
    }
  }
  return true;
}

/**
 * Primary Anti-Virus & Zero-Day Crash Protection interceptor.
 * Returns `true` if the message was a threat or came from a blacklisted attacker (and was neutralized).
 */
export async function inspectAndMitigateThreat(
  sock: WASocket,
  msg: WAMessage
): Promise<boolean> {
  try {
    if (!msg || !msg.message || !msg.key?.remoteJid) return false;
    const chatId = msg.key.remoteJid;
    if (chatId === 'status@broadcast') return false;
    if (msg.key.fromMe) return false;

    const cfg = loadConfig();
    const isGroup = chatId.endsWith('@g.us');

    // Determine whether this chat/session is protected
    const groupCfg = isGroup ? vipStore.getGroupConfig(chatId) : null;
    const botJids = await getBotJids(sock).catch(() => [] as string[]);
    const sessionNums = botJids.map((j) => normalizePhone(jidUserPart(j))).filter(Boolean);
    const ownerClean = normalizePhone(cfg.ownerNumber);
    const isOwnerSession = sessionNums.some((n) => n === ownerClean || vipStore.isOwner(n));
    const isVipSession = sessionNums.some((n) => vipStore.isVip(n));

    const protectedScope = isGroup
      ? Boolean(groupCfg?.antiVirus)
      : Boolean(cfg.antiVirusGlobal || isOwnerSession || isVipSession);

    if (!protectedScope) return false;

    const { senderJid, senderCandidates, senderNumber } = await resolveSenderInfo(sock, msg);
    const isSenderOwner =
      (ownerClean && senderNumber === ownerClean) || vipStore.isOwner(senderNumber);
    if (isSenderOwner) return false;

    const senderIsBot = botJids.some((b) => jidUserPart(b) === jidUserPart(senderJid));
    if (senderIsBot) return false;

    // Gate 1: Drop/Purge any further messages from already-blacklisted attackers immediately
    const existingBlacklist = crashGuardStore.isBlacklisted([
      senderNumber,
      senderJid,
      ...senderCandidates,
    ]);
    if (existingBlacklist) {
      sanitizeMessageInPlace(msg);
      if (isGroup && msg.key?.id) {
        await sock
          .sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: false,
              id: msg.key.id,
              participant: msg.key.participant || senderJid,
            },
          })
          .catch(() => {});
      } else if (!isGroup && msg.key?.id) {
        const tsNum =
          Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) ||
          Math.floor(Date.now() / 1000);
        await sock
          .chatModify(
            {
              deleteForMe: {
                deleteMedia: true,
                key: msg.key,
                timestamp: tsNum,
              },
            },
            chatId
          )
          .catch(() => {});
      }
      return true;
    }

    // Gate 2: Deep Packet, Unicode & Heuristic Inspection
    const trackKey = `${chatId}:${senderNumber || jidUserPart(senderJid)}`;
    const inspection = inspectMessagePayload(msg.message, trackKey);
    if (!inspection.isThreat) return false;

    // Immediately neutralize in-memory BEFORE any downstream handler or cache reads it
    sanitizeMessageInPlace(msg);

    // Ensure duplicate upsert/update events for the same msg ID do not repeat sanctions
    if (!markThreatHandledOnce(msg.key.id)) {
      return true;
    }

    // Resolve PN JID when sender arrived as @lid so blocklist + WhatsApp block both work
    const resolvedCandidates = new Set<string>(senderCandidates.map((c) => normalizeBareJid(c)));
    for (const c of Array.from(resolvedCandidates)) {
      if (isLidUser(c) && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(c);
          if (pn) resolvedCandidates.add(normalizeBareJid(pn));
        } catch {
          // Ignore missing LID mapping
        }
      }
    }
    const allJids = Array.from(resolvedCandidates).filter(Boolean);
    const primaryJid =
      allJids.find((j) => j.endsWith('@s.whatsapp.net')) || senderJid || allJids[0] || chatId;
    const attackerDisplayNum =
      normalizePhone(jidUserPart(primaryJid)) || senderNumber || jidUserPart(primaryJid);

    const categorySummary = inspection.categories.join(', ');
    const reasonSummary = inspection.reasons[0] || 'Zero-Day / Crash Exploit Payload';

    // 1. Instant Persistent Blacklisting (Virus Blacklist + Bot Ban + Anti-Call + WhatsApp Block)
    crashGuardStore.recordBlacklistedAttacker({
      jid: primaryJid,
      number: attackerDisplayNum,
      categories: inspection.categories,
      reason: reasonSummary,
      chatId,
    });
    vipStore.banUser({
      number: attackerDisplayNum || jidUserPart(primaryJid),
      jid: primaryJid,
      reason: `Anti-Virus Blacklist: ${categorySummary}`,
      bannedBy: 'crashGuard',
    });
    anticallStore.blockCaller(primaryJid, attackerDisplayNum, `Anti-Virus (${categorySummary})`);
    await sock.updateBlockStatus(primaryJid, 'block').catch(() => {});

    // 2. Scope-specific Threat Purge & Group Remediation
    let actionTaken = 'Sanitized, Blacklisted & Blocked';
    let scope: ThreatIncidentEntry['scope'] = isGroup
      ? 'group'
      : isOwnerSession
        ? 'owner_ib'
        : isVipSession
          ? 'vip_ib'
          : 'dm';

    if (isGroup) {
      let botIsAdmin = false;
      let targetParticipantId = senderJid;
      try {
        let meta = await getCachedGroupMetadata(sock, chatId);
        let botP = findParticipant(meta.participants, botJids);
        if (!isParticipantAdmin(botP)) {
          meta = await getCachedGroupMetadata(sock, chatId, true);
          botP = findParticipant(meta.participants, botJids);
        }
        botIsAdmin = isParticipantAdmin(botP);
        const senderP = findParticipant(meta.participants, allJids);
        if (senderP?.id) targetParticipantId = senderP.id;
      } catch {
        // Continue safely if metadata fails
      }

      if (botIsAdmin && msg.key?.id) {
        await sock
          .sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              fromMe: false,
              id: msg.key.id,
              participant: msg.key.participant || targetParticipantId,
            },
          })
          .catch(() => {});

        await sock
          .groupParticipantsUpdate(chatId, [targetParticipantId], 'remove')
          .catch(() => {});
        invalidateGroupMetadataCache(chatId);
        actionTaken = 'Deleted Payload, Kicked Attacker, Blacklisted & Blocked';
      }

      if (canNotifyCooldown(`gc-alert:${chatId}:${attackerDisplayNum}`, 10_000)) {
        const groupAlert = [
          `🛡️ *ANTI-VIRUS & ZERO-DAY SHIELD TRIGGERED*`,
          `• Threat: *${categorySummary}* (${inspection.severity.toUpperCase()})`,
          `• Detail: ${reasonSummary}`,
          `• Attacker: @${attackerDisplayNum}`,
          `• Action: ${botIsAdmin ? 'Payload Deleted · Attacker Kicked · Permanently Blacklisted & Blocked' : 'Payload Neutralized · Attacker Permanently Blacklisted & Blocked'}`,
        ].join('\n');
        await sock
          .sendMessage(chatId, {
            text: groupAlert,
            mentions: [targetParticipantId],
          })
          .catch(() => {});
      }
    } else {
      // Private Chat / Owner IB / VIP IB — purge toxic message from user's WhatsApp client immediately
      if (msg.key?.id) {
        const tsNum =
          Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) ||
          Math.floor(Date.now() / 1000);
        await sock
          .chatModify(
            {
              deleteForMe: {
                deleteMedia: true,
                key: msg.key,
                timestamp: tsNum,
              },
            },
            chatId
          )
          .catch(() => {});
      }
      actionTaken = 'Purged From IB, Blacklisted & WhatsApp Blocked';
    }

    crashGuardStore.logIncident({
      attackerJid: primaryJid,
      attackerNumber: attackerDisplayNum,
      chatId,
      scope,
      categories: inspection.categories,
      reason: reasonSummary,
      actionTaken,
    });

    logger.security(
      'crashGuard',
      `Neutralized ${inspection.severity.toUpperCase()} [${categorySummary}] from +${attackerDisplayNum} in ${chatId} (${scope}) -> ${actionTaken}`
    );

    // Notify Owner IB asynchronously when a VIP IB or Group attack is neutralized (not if Owner IB itself was attacked—avoid unnecessary ping loops; still notify cleanly once if wanted)
    if (ownerClean && canNotifyCooldown(`owner-alert:${attackerDisplayNum}`, 20_000)) {
      const ownerJid = `${ownerClean}@s.whatsapp.net`;
      if (ownerJid !== chatId) {
        await sock
          .sendMessage(ownerJid, {
            text: [
              `🛡️ *VIP / Group Crash Threat Neutralized*`,
              `• Scope: *${scope.toUpperCase()}*`,
              `• Target Chat: \`${chatId}\``,
              `• Attacker: +${attackerDisplayNum}`,
              `• Threat: *${categorySummary}*`,
              `• Action: ${actionTaken}`,
            ].join('\n'),
          })
          .catch(() => {});
      }
    }

    return true;
  } catch (err) {
    logger.warn('crashGuard', `Isolated error during threat check: ${(err as Error).message}`);
    return false;
  }
}
