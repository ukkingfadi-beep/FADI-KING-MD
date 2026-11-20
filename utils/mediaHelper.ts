import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { downloadMediaMessage, getContentType, proto, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';

import { extractContextInfo, unwrapMessage } from './jidHelper.ts';

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

export async function convertAudioPartsToWhatsAppVoice(audioParts: Buffer[]): Promise<{
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
      const p = path.join(tmpDir, `${id}_part${i}.mp3`);
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

  const hasFfmpeg = await isFfmpegAvailable();
  if (hasFfmpeg) {
    try {
      const voice = await convertAudioPartsToWhatsAppVoice(audioParts);
      return {
        buffer: voice.buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        lang: detectedLang,
        seconds: voice.seconds,
        waveform: voice.waveform,
      };
    } catch {
      // Fallback cleanly below
    }
  }

  // Fallback as standard audio (ptt: false) because WhatsApp cannot open MP3 with ptt: true
  return {
    buffer: audioParts[0],
    mimetype: 'audio/mpeg',
    ptt: false,
    lang: detectedLang,
  };
}
