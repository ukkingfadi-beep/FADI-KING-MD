import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import {
  downloadContentFromMessage,
  downloadMediaMessage,
  getContentType,
  proto,
  type MediaType,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';

import { resolveDataDir } from './db.ts';
import {
  extractContextInfo,
  hasValidMediaPayload,
  normalizeBareJid,
  unwrapMessage,
} from './jidHelper.ts';
import { isGeminiConfigured, synthesizePakistaniFemaleTts } from './geminiService.ts';
import { logger } from './logger.ts';

const execFileAsync = promisify(execFile);
const silentLogger = pino({ level: 'silent' });

function resolveFfmpegBin(): string {
  if (typeof ffmpegStatic === 'string' && ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  return 'ffmpeg';
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync(resolveFfmpegBin(), ['-version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function extractQuotedMessage(msg: WAMessage): proto.IMessage | null {
  const ctx = extractContextInfo(msg.message);
  if (!ctx?.quotedMessage) return null;
  return unwrapMessage(ctx.quotedMessage) || ctx.quotedMessage;
}

export function isViewOnceMediaMessage(message: proto.IMessage | null | undefined): boolean {
  let current: proto.IMessage | undefined = message || undefined;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message
    ) {
      return true;
    }
    if (
      current.imageMessage?.viewOnce ||
      current.videoMessage?.viewOnce ||
      current.audioMessage?.viewOnce ||
      current.ptvMessage?.viewOnce
    ) {
      return true;
    }
    const next: proto.IMessage | null | undefined =
      current.ephemeralMessage?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message ||
      current.botInvokeMessage?.message ||
      current.groupStatusMessage?.message ||
      current.groupStatusMessageV2?.message ||
      current.associatedChildMessage?.message;
    if (!next) break;
    current = next;
  }
  return false;
}

export function unwrapViewOnce(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) return null;
  let current: proto.IMessage | undefined = message;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const next: proto.IMessage | null | undefined =
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.ephemeralMessage?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message ||
      current.botInvokeMessage?.message ||
      current.groupStatusMessage?.message ||
      current.groupStatusMessageV2?.message ||
      current.associatedChildMessage?.message;
    if (!next) break;
    current = next;
  }
  const unwrapped = unwrapMessage(current) || current;
  if (
    unwrapped?.imageMessage ||
    unwrapped?.videoMessage ||
    unwrapped?.ptvMessage ||
    unwrapped?.audioMessage
  ) {
    return unwrapped;
  }
  return null;
}

function toBinaryBuffer(val: unknown): Uint8Array | undefined {
  if (!val) return undefined;
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) return val;
  if (typeof val === 'string') {
    try {
      return Buffer.from(val, 'base64');
    } catch {
      return undefined;
    }
  }
  if (typeof val === 'object') {
    const obj = val as { data?: number[] } & Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      return Uint8Array.from(obj.data);
    }
    if ('0' in obj) {
      const nums: number[] = [];
      for (let i = 0; String(i) in obj; i += 1) {
        nums.push(Number(obj[String(i)] || 0));
      }
      if (nums.length > 0) return Uint8Array.from(nums);
    }
  }
  return undefined;
}

function ensureDownloadableUrl(message: proto.IMessage): proto.IMessage {
  const clone: proto.IMessage = { ...message };
  for (const key of ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'stickerMessage', 'documentMessage'] as const) {
    const media = clone[key];
    if (!media) continue;
    const cleanUrl = typeof media.url === 'string' ? media.url.trim() : '';
    const rawDirect =
      typeof media.directPath === 'string' && media.directPath.trim()
        ? media.directPath.trim()
        : 'thumbnailDirectPath' in media &&
            typeof (media as { thumbnailDirectPath?: unknown }).thumbnailDirectPath === 'string'
          ? (media as { thumbnailDirectPath: string }).thumbnailDirectPath.trim()
          : '';
    const resolvedUrl =
      cleanUrl || (rawDirect ? `https://mmg.whatsapp.net${rawDirect.startsWith('/') ? '' : '/'}${rawDirect}` : '');
    const normalizedKey = toBinaryBuffer(media.mediaKey);
    const normalizedEncSha = toBinaryBuffer(media.fileEncSha256);
    const normalizedSha = toBinaryBuffer(media.fileSha256);

    clone[key] = {
      ...media,
      ...(resolvedUrl ? { url: resolvedUrl } : {}),
      ...(normalizedKey ? { mediaKey: normalizedKey } : {}),
      ...(normalizedEncSha ? { fileEncSha256: normalizedEncSha } : {}),
      ...(normalizedSha ? { fileSha256: normalizedSha } : {}),
    } as typeof media;
  }
  return clone;
}

export async function downloadMessageMedia(
  sock: WASocket,
  targetMessage: WAMessage
): Promise<Buffer> {
  const unwrapped = targetMessage.message ? unwrapMessage(targetMessage.message) || targetMessage.message : undefined;
  const normalizedInner = unwrapped ? ensureDownloadableUrl(unwrapped) : undefined;
  const normalizedMessage: WAMessage = normalizedInner
    ? { ...targetMessage, message: normalizedInner }
    : targetMessage;

  try {
    const result = await downloadMediaMessage(
      normalizedMessage,
      'buffer',
      {},
      {
        logger: silentLogger as unknown as Parameters<typeof sock.updateMediaMessage>[0] extends never ? never : any,
        reuploadRequest: sock.updateMediaMessage,
      }
    );
    const buf = Buffer.isBuffer(result) ? result : Buffer.from(result);
    if (buf.length > 0) return buf;
  } catch (primaryErr) {
    // Fall back to direct HKDF stream decryption via downloadContentFromMessage
    if (normalizedInner) {
      const mapping: Array<[keyof proto.IMessage, MediaType]> = [
        ['imageMessage', 'image'],
        ['videoMessage', 'video'],
        ['ptvMessage', 'ptv'],
        ['audioMessage', 'audio'],
        ['stickerMessage', 'sticker'],
        ['documentMessage', 'document'],
      ];
      for (const [field, mediaType] of mapping) {
        const node = normalizedInner[field] as
          | { mediaKey?: Uint8Array | null; directPath?: string | null; url?: string | null }
          | undefined;
        if (node && node.mediaKey && (node.directPath || node.url)) {
          try {
            const stream = await downloadContentFromMessage(node, mediaType);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const directBuf = Buffer.concat(chunks);
            if (directBuf.length > 0) return directBuf;
          } catch {
            // Throw original error below if direct fallback also fails
          }
        }
      }
    }
    throw primaryErr;
  }

  throw new Error('Downloaded media buffer was empty.');
}

export interface CachedViewOnceEntry {
  type: 'image' | 'video' | 'audio';
  buffer: Buffer;
  mimetype?: string;
  caption?: string;
  ptt?: boolean;
  seconds?: number;
}

const MAX_VIEW_ONCE_CACHE_ITEMS = 45;
const MAX_VIEW_ONCE_CACHE_BYTES = 25 * 1024 * 1024;
const viewOnceMediaCache = new Map<string, CachedViewOnceEntry>();
const viewOnceInflight = new Map<string, Promise<void>>();
const unavailableViewOnceKeys = new Map<string, WAMessage['key']>();

export function recordUnavailableViewOnceKey(key: WAMessage['key'] | null | undefined): void {
  const id = key?.id;
  if (!id) return;
  unavailableViewOnceKeys.set(id, key);
  if (unavailableViewOnceKeys.size > 200) {
    const oldest = unavailableViewOnceKeys.keys().next().value;
    if (oldest) unavailableViewOnceKeys.delete(oldest);
  }
}

export function getUnavailableViewOnceKey(msgId: string): WAMessage['key'] | undefined {
  if (!msgId) return undefined;
  return unavailableViewOnceKeys.get(msgId);
}

function getViewOnceDiskDir(): string {
  const dir = path.join(resolveDataDir(), 'viewonce_cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function safeCacheId(msgId: string): string {
  return msgId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
}

async function persistViewOnceToDisk(msgId: string, entry: CachedViewOnceEntry): Promise<void> {
  try {
    const dir = getViewOnceDiskDir();
    const id = safeCacheId(msgId);
    const binPath = path.join(dir, `${id}.bin`);
    const metaPath = path.join(dir, `${id}.json`);
    const meta = {
      type: entry.type,
      mimetype: entry.mimetype,
      caption: entry.caption,
      ptt: entry.ptt,
      seconds: entry.seconds,
      savedAt: Date.now(),
    };
    await Promise.all([
      fs.promises.writeFile(binPath, entry.buffer),
      fs.promises.writeFile(metaPath, JSON.stringify(meta), 'utf-8'),
    ]);

    // Auto-prune old View-Once files beyond 45 entries
    const files = await fs.promises.readdir(dir).catch(() => []);
    const metas = files.filter((f) => f.endsWith('.json'));
    if (metas.length > MAX_VIEW_ONCE_CACHE_ITEMS) {
      const stats = await Promise.all(
        metas.map(async (f) => ({
          name: f,
          mtime: (await fs.promises.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
        }))
      );
      stats.sort((a, b) => a.mtime - b.mtime);
      for (const old of stats.slice(0, stats.length - MAX_VIEW_ONCE_CACHE_ITEMS)) {
        const stem = old.name.replace(/\.json$/, '');
        await fs.promises.unlink(path.join(dir, `${stem}.json`)).catch(() => {});
        await fs.promises.unlink(path.join(dir, `${stem}.bin`)).catch(() => {});
      }
    }
  } catch {
    // Non-fatal disk cache failure
  }
}

function readViewOnceFromDisk(msgId: string): CachedViewOnceEntry | undefined {
  if (!msgId) return undefined;
  try {
    const dir = getViewOnceDiskDir();
    const id = safeCacheId(msgId);
    const metaPath = path.join(dir, `${id}.json`);
    const binPath = path.join(dir, `${id}.bin`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) return undefined;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<CachedViewOnceEntry>;
    const buffer = fs.readFileSync(binPath);
    if (!buffer.length || !meta.type) return undefined;
    const entry: CachedViewOnceEntry = {
      type: meta.type,
      buffer,
      mimetype: meta.mimetype,
      caption: meta.caption,
      ptt: meta.ptt,
      seconds: meta.seconds,
    };
    viewOnceMediaCache.set(`id:${msgId}`, entry);
    return entry;
  } catch {
    return undefined;
  }
}

export function getCachedViewOnceMedia(
  chatId: string,
  msgId: string
): CachedViewOnceEntry | undefined {
  if (!msgId) return undefined;
  const bareChat = normalizeBareJid(chatId);
  return (
    viewOnceMediaCache.get(`${bareChat}:${msgId}`) ||
    viewOnceMediaCache.get(`${chatId}:${msgId}`) ||
    viewOnceMediaCache.get(`id:${msgId}`) ||
    readViewOnceFromDisk(msgId)
  );
}

export async function waitForViewOnceInflight(msgId: string): Promise<void> {
  const pending = viewOnceInflight.get(msgId);
  if (pending) {
    await pending.catch(() => {});
  }
}

function serializeMediaFieldsForDisk(inner: proto.IMessage): Record<string, unknown> | null {
  for (const field of ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage'] as const) {
    const m = inner[field];
    if (!m) continue;
    const keyBuf = toBinaryBuffer(m.mediaKey);
    const encSha = toBinaryBuffer(m.fileEncSha256);
    const sha = toBinaryBuffer(m.fileSha256);
    return {
      field,
      payload: {
        url: typeof m.url === 'string' ? m.url : undefined,
        directPath: typeof m.directPath === 'string' ? m.directPath : undefined,
        mimetype: typeof m.mimetype === 'string' ? m.mimetype : undefined,
        caption: 'caption' in m && typeof m.caption === 'string' ? m.caption : undefined,
        ptt: 'ptt' in m ? m.ptt : undefined,
        seconds: 'seconds' in m ? m.seconds : undefined,
        mediaKey: keyBuf ? Buffer.from(keyBuf).toString('base64') : undefined,
        fileEncSha256: encSha ? Buffer.from(encSha).toString('base64') : undefined,
        fileSha256: sha ? Buffer.from(sha).toString('base64') : undefined,
        viewOnce: true,
      },
    };
  }
  return null;
}

async function persistViewOnceMetaToDisk(msg: WAMessage, inner: proto.IMessage): Promise<void> {
  const msgId = msg.key?.id;
  if (!msgId) return;
  const serialized = serializeMediaFieldsForDisk(inner);
  if (!serialized) return;
  try {
    const dir = getViewOnceDiskDir();
    const id = safeCacheId(msgId);
    const origPath = path.join(dir, `${id}.orig.json`);
    await fs.promises.writeFile(
      origPath,
      JSON.stringify({ key: msg.key, ...serialized, savedAt: Date.now() }),
      'utf-8'
    );
  } catch {
    // Non-fatal metadata persistence error
  }
}

export function getCachedViewOnceMeta(msgId: string): WAMessage | undefined {
  if (!msgId) return undefined;
  try {
    const dir = getViewOnceDiskDir();
    const id = safeCacheId(msgId);
    const origPath = path.join(dir, `${id}.orig.json`);
    if (!fs.existsSync(origPath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(origPath, 'utf-8')) as {
      key?: WAMessage['key'];
      field?: 'imageMessage' | 'videoMessage' | 'ptvMessage' | 'audioMessage';
      payload?: Record<string, unknown>;
    };
    if (!raw?.field || !raw?.payload) return undefined;
    const p = { ...raw.payload };
    if (typeof p.mediaKey === 'string') p.mediaKey = Buffer.from(p.mediaKey, 'base64');
    if (typeof p.fileEncSha256 === 'string') p.fileEncSha256 = Buffer.from(p.fileEncSha256, 'base64');
    if (typeof p.fileSha256 === 'string') p.fileSha256 = Buffer.from(p.fileSha256, 'base64');
    return {
      key: raw.key || { id: msgId },
      message: { [raw.field]: p } as proto.IMessage,
    };
  } catch {
    return undefined;
  }
}

export async function precacheViewOnceMedia(
  sock: WASocket,
  msg: WAMessage
): Promise<void> {
  const chatId = msg.key?.remoteJid;
  const msgId = msg.key?.id;
  if (!chatId || !msgId || !msg.message) return;
  if (!isViewOnceMediaMessage(msg.message)) return;

  const bareChat = normalizeBareJid(chatId);
  const idKey = `id:${msgId}`;
  if (viewOnceMediaCache.has(idKey) || viewOnceInflight.has(msgId)) return;

  const inner = unwrapViewOnce(msg.message);
  if (!inner || !hasValidMediaPayload(inner)) return;

  const mediaType = detectMediaType(inner);
  if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'audio') return;

  // Immediately persist raw mediaKey/directPath metadata so restarts never lose it
  void persistViewOnceMetaToDisk(msg, inner);

  const task = (async () => {
    try {
      let buf: Buffer | null = null;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          buf = await downloadMessageMedia(sock, {
            key: msg.key,
            message: inner,
          });
          if (buf && buf.length > 0) break;
        } catch (err) {
          lastErr = err;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 900));
          }
        }
      }
      if (!buf || buf.length === 0) {
        if (lastErr) {
          logger.warn('viewOnce', `Precache download deferred for ${msgId}: ${(lastErr as Error).message}`);
        }
        return;
      }
      if (buf.length > MAX_VIEW_ONCE_CACHE_BYTES) return;

      const entry: CachedViewOnceEntry = {
        type: mediaType,
        buffer: buf,
        mimetype:
          inner.audioMessage?.mimetype ||
          inner.videoMessage?.mimetype ||
          inner.ptvMessage?.mimetype ||
          inner.imageMessage?.mimetype ||
          undefined,
        caption:
          inner.imageMessage?.caption ||
          inner.videoMessage?.caption ||
          undefined,
        ptt: inner.audioMessage ? inner.audioMessage.ptt !== false : undefined,
        seconds:
          inner.audioMessage?.seconds ||
          inner.videoMessage?.seconds ||
          inner.ptvMessage?.seconds ||
          undefined,
      };

      viewOnceMediaCache.set(`${bareChat}:${msgId}`, entry);
      viewOnceMediaCache.set(idKey, entry);

      while (viewOnceMediaCache.size > MAX_VIEW_ONCE_CACHE_ITEMS * 2) {
        const oldest = viewOnceMediaCache.keys().next().value;
        if (!oldest) break;
        viewOnceMediaCache.delete(oldest);
      }

      void persistViewOnceToDisk(msgId, entry);
    } catch (err) {
      logger.warn('viewOnce', `Precache error for ${msgId}: ${(err as Error).message}`);
    } finally {
      viewOnceInflight.delete(msgId);
    }
  })();

  viewOnceInflight.set(msgId, task);
  await task;
}

export async function convertMediaToWebpSticker(inputBuffer: Buffer, isVideo: boolean): Promise<Buffer> {
  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error('FFmpeg is not installed on this server. Install ffmpeg to convert images/videos into WebP stickers.');
  }

  const bin = resolveFfmpegBin();
  const tmpDir = os.tmpdir();
  const id = `fkmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(tmpDir, `${id}.${isVideo ? 'mp4' : 'png'}`);
  const outPath = path.join(tmpDir, `${id}.webp`);

  try {
    await fs.promises.writeFile(inPath, inputBuffer);
    const args = isVideo
      ? [
          '-y',
          '-i', inPath,
          '-vcodec', 'libwebp',
          '-vf', "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0",
          '-loop', '0',
          '-ss', '00:00:00',
          '-t', '00:00:08',
          '-preset', 'default',
          '-an',
          '-vsync', '0',
          outPath,
        ]
      : [
          '-y',
          '-i', inPath,
          '-vcodec', 'libwebp',
          '-vf', "scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0",
          '-lossless', '1',
          '-preset', 'default',
          '-an',
          '-vsync', '0',
          outPath,
        ];

    await execFileAsync(bin, args, { timeout: 20000 });
    return await fs.promises.readFile(outPath);
  } finally {
    await fs.promises.unlink(inPath).catch(() => {});
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

export async function convertStickerToPng(webpBuffer: Buffer): Promise<Buffer> {
  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error('FFmpeg is not installed on this server. Install ffmpeg to convert WebP stickers back to PNG.');
  }

  const bin = resolveFfmpegBin();
  const tmpDir = os.tmpdir();
  const id = `fkmd_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(tmpDir, `${id}.webp`);
  const outPath = path.join(tmpDir, `${id}.png`);

  try {
    await fs.promises.writeFile(inPath, webpBuffer);
    await execFileAsync(bin, ['-y', '-i', inPath, outPath], { timeout: 15000 });
    return await fs.promises.readFile(outPath);
  } finally {
    await fs.promises.unlink(inPath).catch(() => {});
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

export function detectMediaType(message: proto.IMessage | null | undefined): 'image' | 'video' | 'sticker' | 'audio' | 'unknown' {
  if (!message) return 'unknown';
  const type = getContentType(message);
  if (type === 'imageMessage') return 'image';
  if (type === 'videoMessage' || type === 'ptvMessage') return 'video';
  if (type === 'stickerMessage') return 'sticker';
  if (type === 'audioMessage') return 'audio';
  return 'unknown';
}

function splitTtsChunks(text: string, maxLen = 180): string[] {
  const words = text.trim().split(/\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word.slice(0, maxLen);
    } else if (current.length + 1 + word.length <= maxLen) {
      current += ` ${word}`;
    } else {
      chunks.push(current);
      current = word.slice(0, maxLen);
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 4);
}

function computePcmWaveformAndSeconds(pcmBuffer: Buffer, sampleRate = 8000): {
  seconds: number;
  waveform: Uint8Array;
} {
  const totalSamples = Math.floor(pcmBuffer.length / 2);
  const seconds = Math.max(1, Math.round(totalSamples / sampleRate));
  const bars = 64;
  const waveform = new Uint8Array(bars);

  if (totalSamples < bars) {
    waveform.fill(35);
    return { seconds, waveform };
  }

  const blockSize = Math.max(1, Math.floor(totalSamples / bars));
  const amplitudes: number[] = [];
  let maxAmp = 1;

  for (let i = 0; i < bars; i += 1) {
    const startSample = i * blockSize;
    let sum = 0;
    let count = 0;
    for (let j = 0; j < blockSize && startSample + j < totalSamples; j += 1) {
      const val = Math.abs(pcmBuffer.readInt16LE((startSample + j) * 2));
      sum += val;
      count += 1;
    }
    const avg = count > 0 ? sum / count : 0;
    amplitudes.push(avg);
    if (avg > maxAmp) maxAmp = avg;
  }

  for (let i = 0; i < bars; i += 1) {
    waveform[i] = Math.min(100, Math.max(8, Math.round((amplitudes[i] / maxAmp) * 100)));
  }

  return { seconds, waveform };
}

export async function convertAudioPartsToWhatsAppVoice(
  audioParts: Buffer[],
  inputExt: 'mp3' | 'wav' = 'mp3'
): Promise<{
  buffer: Buffer;
  seconds: number;
  waveform: Uint8Array;
}> {
  const bin = resolveFfmpegBin();
  const tmpDir = os.tmpdir();
  const id = `fkmd_tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const partPaths: string[] = [];
  const concatListPath = path.join(tmpDir, `${id}_list.txt`);
  const outOggPath = path.join(tmpDir, `${id}.ogg`);
  const outPcmPath = path.join(tmpDir, `${id}.pcm`);

  try {
    for (let i = 0; i < audioParts.length; i += 1) {
      const p = path.join(tmpDir, `${id}_part${i}.${inputExt}`);
      await fs.promises.writeFile(p, audioParts[i]);
      partPaths.push(p);
    }

    let inputArgs: string[];
    if (partPaths.length === 1) {
      inputArgs = ['-i', partPaths[0]];
    } else {
      const listContent = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await fs.promises.writeFile(concatListPath, listContent, 'utf-8');
      inputArgs = ['-f', 'concat', '-safe', '0', '-i', concatListPath];
    }

    // 1. Produce clean WhatsApp-compliant OGG/Opus PTT voice note
    await execFileAsync(
      bin,
      [
        '-y',
        ...inputArgs,
        '-map_metadata', '-1',
        '-vn',
        '-c:a', 'libopus',
        '-application', 'voip',
        '-b:a', '32k',
        '-ar', '48000',
        '-ac', '1',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'ogg',
        outOggPath,
      ],
      { timeout: 18000 }
    );

    // 2. Decode the generated OGG to lightweight 8kHz mono s16le PCM to compute exact seconds + waveform
    await execFileAsync(
      bin,
      ['-y', '-i', outOggPath, '-f', 's16le', '-ac', '1', '-ar', '8000', outPcmPath],
      { timeout: 12000 }
    );

    const [oggBuffer, pcmBuffer] = await Promise.all([
      fs.promises.readFile(outOggPath),
      fs.promises.readFile(outPcmPath),
    ]);
    const { seconds, waveform } = computePcmWaveformAndSeconds(pcmBuffer, 8000);

    return { buffer: oggBuffer, seconds, waveform };
  } finally {
    await Promise.all([
      ...partPaths.map((p) => fs.promises.unlink(p).catch(() => {})),
      fs.promises.unlink(concatListPath).catch(() => {}),
      fs.promises.unlink(outOggPath).catch(() => {}),
      fs.promises.unlink(outPcmPath).catch(() => {}),
    ]);
  }
}

export async function convertAudioToOggOpus(mp3Buffer: Buffer): Promise<Buffer> {
  const res = await convertAudioPartsToWhatsAppVoice([mp3Buffer]);
  return res.buffer;
}

export async function synthesizeTtsVoiceNote(
  rawText: string,
  langHint?: string
): Promise<{
  buffer: Buffer;
  mimetype: string;
  ptt: boolean;
  lang: string;
  seconds?: number;
  waveform?: Uint8Array;
}> {
  const clean = rawText.trim().slice(0, 650);
  if (!clean) {
    throw new Error('Provide text or reply to a message for `.tts`.');
  }

  const detectedLang = langHint || (/[\u0600-\u06FF]/.test(clean) ? 'ur' : 'ur-PK');

  // Prefer natural Pakistani female voice via Gemini 3.8 Flash TTS when API key is configured
  if (isGeminiConfigured()) {
    const wavBuffer = await synthesizePakistaniFemaleTts(clean);
    const hasFfmpeg = await isFfmpegAvailable();
    if (hasFfmpeg) {
      const voice = await convertAudioPartsToWhatsAppVoice([wavBuffer], 'wav');
      return {
        buffer: voice.buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        lang: detectedLang,
        seconds: voice.seconds,
        waveform: voice.waveform,
      };
    }
    return {
      buffer: wavBuffer,
      mimetype: 'audio/wav',
      ptt: false,
      lang: detectedLang,
    };
  }

  // Real HTTP TTS fallback when GEMINI_API_KEY is not present
  const fallbackLang = langHint || (/[\u0600-\u06FF]/.test(clean) ? 'ur' : 'en');
  const chunks = splitTtsChunks(clean, 180);
  const audioParts: Buffer[] = [];

  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      chunk
    )}&tl=${encodeURIComponent(fallbackLang)}&client=tw-ob`;

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`TTS speech service returned HTTP ${res.status}`);
    }
    const arr = await res.arrayBuffer();
    if (arr.byteLength > 0) {
      audioParts.push(Buffer.from(arr));
    }
  }

  if (audioParts.length === 0) {
    throw new Error('Could not synthesize voice audio for that text.');
  }

  const hasFfmpeg = await isFfmpegAvailable();
  if (hasFfmpeg) {
    try {
      const voice = await convertAudioPartsToWhatsAppVoice(audioParts, 'mp3');
      return {
        buffer: voice.buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        lang: fallbackLang,
        seconds: voice.seconds,
        waveform: voice.waveform,
      };
    } catch {
      // Fallback cleanly below
    }
  }

  return {
    buffer: audioParts[0],
    mimetype: 'audio/mpeg',
    ptt: false,
    lang: fallbackLang,
  };
}
