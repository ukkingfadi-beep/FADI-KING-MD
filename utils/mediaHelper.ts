import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { downloadMediaMessage, getContentType, proto, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';

import { extractContextInfo, unwrapMessage } from './jidHelper.ts';

const execFileAsync = promisify(execFile);
const silentLogger = pino({ level: 'silent' });

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
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

export function unwrapViewOnce(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) return null;
  const unwrapped = unwrapMessage(message) || message;
  if (unwrapped.viewOnceMessage?.message) return unwrapped.viewOnceMessage.message;
  if (unwrapped.viewOnceMessageV2?.message) return unwrapped.viewOnceMessageV2.message;
  if (unwrapped.viewOnceMessageV2Extension?.message) return unwrapped.viewOnceMessageV2Extension.message;
  return unwrapped.imageMessage || unwrapped.videoMessage || unwrapped.audioMessage ? unwrapped : null;
}

export async function downloadMessageMedia(
  sock: WASocket,
  targetMessage: WAMessage
): Promise<Buffer> {
  const result = await downloadMediaMessage(
    targetMessage,
    'buffer',
    {},
    {
      logger: silentLogger as unknown as Parameters<typeof sock.updateMediaMessage>[0] extends never ? never : any,
      reuploadRequest: sock.updateMediaMessage,
    }
  );
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
}

export async function convertMediaToWebpSticker(inputBuffer: Buffer, isVideo: boolean): Promise<Buffer> {
  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error('FFmpeg is not installed on this server. Install ffmpeg to convert images/videos into WebP stickers.');
  }

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

    await execFileAsync('ffmpeg', args, { timeout: 20000 });
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

  const tmpDir = os.tmpdir();
  const id = `fkmd_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(tmpDir, `${id}.webp`);
  const outPath = path.join(tmpDir, `${id}.png`);

  try {
    await fs.promises.writeFile(inPath, webpBuffer);
    await execFileAsync('ffmpeg', ['-y', '-i', inPath, outPath], { timeout: 15000 });
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
  if (type === 'videoMessage') return 'video';
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

export async function convertAudioToOggOpus(mp3Buffer: Buffer): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const id = `fkmd_tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(tmpDir, `${id}.mp3`);
  const outPath = path.join(tmpDir, `${id}.ogg`);

  try {
    await fs.promises.writeFile(inPath, mp3Buffer);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', inPath, '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', outPath],
      { timeout: 15000 }
    );
    return await fs.promises.readFile(outPath);
  } finally {
    await fs.promises.unlink(inPath).catch(() => {});
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

export async function synthesizeTtsVoiceNote(
  rawText: string,
  langHint?: string
): Promise<{ buffer: Buffer; mimetype: string; ptt: boolean; lang: string }> {
  const clean = rawText.trim().slice(0, 650);
  if (!clean) {
    throw new Error('Provide text or reply to a message for `.tts`.');
  }

  const detectedLang = langHint || (/[\u0600-\u06FF]/.test(clean) ? 'ur' : 'en');
  const chunks = splitTtsChunks(clean, 180);
  const audioParts: Buffer[] = [];

  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      chunk
    )}&tl=${encodeURIComponent(detectedLang)}&client=tw-ob`;

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

  const mp3Buffer = Buffer.concat(audioParts);
  const hasFfmpeg = await isFfmpegAvailable();
  if (hasFfmpeg) {
    try {
      const oggBuffer = await convertAudioToOggOpus(mp3Buffer);
      return {
        buffer: oggBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        lang: detectedLang,
      };
    } catch {
      // Fallback cleanly to MP3 voice note if libopus fails
    }
  }

  return {
    buffer: mp3Buffer,
    mimetype: 'audio/mpeg',
    ptt: true,
    lang: detectedLang,
  };
}
