import { logger } from './logger.ts';

export type SocialPlatform = 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'twitter' | 'pinterest';

export interface DownloadedMediaItem {
  kind: 'video' | 'image' | 'audio';
  buffer: Buffer;
  mimetype: string;
  filename?: string;
}

export interface SocialDownloadResult {
  platform: SocialPlatform;
  title: string;
  author?: string;
  items: DownloadedMediaItem[];
}

const MAX_MEDIA_BYTES = 58 * 1024 * 1024; // 58 MB cap prevents OOM crashes & WhatsApp send failures
const REQUEST_TIMEOUT_MS = 24_000;
const DOWNLOAD_TIMEOUT_MS = 75_000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ANDROID_VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

// Global outbound rate-limiter per platform to avoid upstream IP bans
const platformHits = new Map<SocialPlatform, number[]>();

export function checkPlatformDownloadQuota(platform: SocialPlatform): { allowed: boolean; waitSec: number } {
  const now = Date.now();
  const windowMs = 60_000;
  const maxPerMinute = 20;
  const recent = (platformHits.get(platform) || []).filter((ts) => now - ts < windowMs);
  if (recent.length >= maxPerMinute) {
    const oldest = recent[0] || now;
    return { allowed: false, waitSec: Math.max(2, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  recent.push(now);
  platformHits.set(platform, recent);
  return { allowed: true, waitSec: 0 };
}

export function extractFirstValidUrl(rawText: string): string | null {
  const match = rawText.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  return match[0].replace(/[),.;!?]+$/, '');
}

async function resolveFinalUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(12_000),
    });
    const finalUrl = res.url || url;
    await res.body?.cancel().catch(() => {});
    return finalUrl.split('#')[0];
  } catch {
    return url;
  }
}

async function fetchBufferWithLimit(
  url: string,
  headers?: Record<string, string>,
  maxBytes = MAX_MEDIA_BYTES
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
      ...(headers || {}),
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Media server returned HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  if (contentType.toLowerCase().includes('text/html')) {
    await res.body?.cancel().catch(() => {});
    throw new Error('Upstream returned an HTML page instead of a media stream');
  }

  const contentLen = Number(res.headers.get('content-length') || 0);
  if (contentLen > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `File is too large (${(contentLen / (1024 * 1024)).toFixed(1)} MB). Max safe limit is ${Math.round(
        maxBytes / (1024 * 1024)
      )} MB.`
    );
  }

  if (!res.body) {
    const arr = await res.arrayBuffer();
    if (arr.byteLength > maxBytes) {
      throw new Error(`File exceeded ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`);
    }
    if (arr.byteLength === 0) {
      throw new Error('Downloaded media stream was empty');
    }
    return { buffer: Buffer.from(arr), contentType };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Stream exceeded ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`);
      }
      chunks.push(value);
    }
  }

  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) {
    throw new Error('Downloaded media buffer was empty');
  }

  return {
    buffer,
    contentType,
  };
}

function unescapeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&quot;/g, '"');
}

function getCobaltEndpoints(): string[] {
  const custom = process.env.COBALT_API_URL?.trim();
  if (!custom) return [];
  return [custom.replace(/\/+$/, '')];
}

async function queryCobaltApi(params: {
  url: string;
  audioOnly?: boolean;
  videoQuality?: string;
}): Promise<{ mediaUrl: string; filename?: string; isAudio: boolean; isImage: boolean; pickerUrls?: string[] }> {
  const endpoints = getCobaltEndpoints();
  if (endpoints.length === 0) {
    throw new Error('No custom COBALT_API_URL configured');
  }

  const apiKey = process.env.COBALT_API_KEY?.trim();
  let lastErr = 'Cobalt extractor unavailable';

  for (const base of endpoints) {
    try {
      const payload = {
        url: params.url,
        downloadMode: params.audioOnly ? 'audio' : 'auto',
        videoQuality: params.videoQuality || '720',
        audioFormat: 'mp3',
        filenameStyle: 'basic',
        tiktokFullAudio: true,
        youtubeVideoCodec: 'h264',
      };

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
      };
      if (apiKey) {
        headers.Authorization = apiKey.startsWith('Api-Key ') || apiKey.startsWith('Bearer ')
          ? apiKey
          : `Api-Key ${apiKey}`;
      }

      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const data = (await res.json().catch(() => null)) as {
        status?: string;
        url?: string;
        filename?: string;
        picker?: Array<{ type?: string; url?: string }>;
        error?: { code?: string };
      } | null;

      if (!res.ok || !data) {
        lastErr = `HTTP ${res.status} from extractor`;
        continue;
      }

      if ((data.status === 'tunnel' || data.status === 'redirect') && data.url) {
        return {
          mediaUrl: data.url,
          filename: data.filename,
          isAudio: Boolean(params.audioOnly),
          isImage: /\.(jpg|jpeg|png|webp)(\?|$)/i.test(data.url),
        };
      }

      if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
        const urls = data.picker.map((p) => p.url).filter((u): u is string => Boolean(u));
        if (urls.length > 0) {
          return {
            mediaUrl: urls[0],
            isAudio: false,
            isImage: data.picker.every((p) => p.type === 'photo'),
            pickerUrls: urls.slice(0, 6),
          };
        }
      }

      if (data.error?.code) {
        lastErr = `Extractor error: ${data.error.code}`;
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }

  throw new Error(lastErr);
}

// ============================================================================
// 1. TIKTOK (Watermark-Free Video + Photo Slideshows via TikWM + Direct Rehydration)
// ============================================================================
function normalizeTikWmUrl(raw?: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `https://www.tikwm.com${trimmed}`;
  return trimmed;
}

interface TikWmPayload {
  code?: number;
  msg?: string;
  data?: {
    title?: string;
    author?: { nickname?: string; unique_id?: string };
    hdplay?: string;
    play?: string;
    wmplay?: string;
    music?: string;
    images?: string[];
  };
}

async function queryTikWm(targetUrl: string): Promise<TikWmPayload['data'] | null> {
  // Try GET first
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        Referer: 'https://www.tikwm.com/',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as TikWmPayload | null;
      if (json?.code === 0 && json.data) return json.data;
    }
  } catch {
    // Fall through to POST
  }

  // Fallback to form-encoded POST
  try {
    const res = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: 'https://www.tikwm.com/',
      },
      body: new URLSearchParams({ url: targetUrl, hd: '1' }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as TikWmPayload | null;
      if (json?.code === 0 && json.data) return json.data;
    }
  } catch {
    // Let next tier handle
  }
  return null;
}

function findTikTokItemStruct(obj: unknown, depth = 0): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.itemStruct && typeof rec.itemStruct === 'object') {
    return rec.itemStruct as Record<string, unknown>;
  }
  if ((rec.video || rec.imagePost) && (rec.id || rec.desc !== undefined)) {
    return rec;
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      const found = findTikTokItemStruct(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function downloadTikTokFromWebpage(
  targetUrl: string,
  audioOnly: boolean
): Promise<SocialDownloadResult> {
  const res = await fetch(targetUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.tiktok.com/',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`TikTok page returned HTTP ${res.status}`);
  }

  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : [];
  const fallbackCookie = res.headers.get('set-cookie');
  const cookieHeader = (setCookies.length > 0 ? setCookies : fallbackCookie ? [fallbackCookie] : [])
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  const html = await res.text();
  const rehydrationMatch =
    html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i);

  if (!rehydrationMatch?.[1]) {
    throw new Error('Could not locate TikTok media payload in page response');
  }

  const parsed = JSON.parse(rehydrationMatch[1]) as unknown;
  const item = findTikTokItemStruct(parsed);
  if (!item) {
    throw new Error('TikTok post metadata missing (video may be private or removed)');
  }

  const authorObj = (item.author || {}) as { nickname?: string; uniqueId?: string };
  const author = authorObj.nickname || authorObj.uniqueId || 'TikTok Creator';
  const title = (typeof item.desc === 'string' && item.desc.trim() ? item.desc : 'TikTok Media').slice(0, 220);

  const reqHeaders: Record<string, string> = {
    Referer: 'https://www.tiktok.com/',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  if (audioOnly) {
    const music = (item.music || {}) as { playUrl?: string };
    if (music.playUrl) {
      const { buffer } = await fetchBufferWithLimit(music.playUrl, reqHeaders);
      return {
        platform: 'tiktok',
        title,
        author,
        items: [{ kind: 'audio', buffer, mimetype: 'audio/mpeg', filename: 'tiktok-audio.mp3' }],
      };
    }
  }

  const imagePost = item.imagePost as { images?: Array<{ imageURL?: { urlList?: string[] } }> } | undefined;
  if (Array.isArray(imagePost?.images) && imagePost.images.length > 0) {
    const items: DownloadedMediaItem[] = [];
    for (const img of imagePost.images.slice(0, 6)) {
      const imgUrl = img.imageURL?.urlList?.[0];
      if (!imgUrl) continue;
      const { buffer, contentType } = await fetchBufferWithLimit(imgUrl, reqHeaders);
      items.push({
        kind: 'image',
        buffer,
        mimetype: contentType.startsWith('image/') ? contentType : 'image/jpeg',
      });
    }
    if (items.length > 0) {
      return { platform: 'tiktok', title, author, items };
    }
  }

  const videoObj = (item.video || {}) as {
    playAddr?: string;
    downloadAddr?: string;
    bitrateInfo?: Array<{ Bitrate?: number; PlayAddr?: { UrlList?: string[] } }>;
  };

  const candidates: string[] = [];
  if (Array.isArray(videoObj.bitrateInfo)) {
    const sorted = [...videoObj.bitrateInfo].sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
    for (const b of sorted) {
      for (const u of b.PlayAddr?.UrlList || []) {
        if (u && !candidates.includes(u)) candidates.push(u);
      }
    }
  }
  for (const direct of [videoObj.playAddr, videoObj.downloadAddr]) {
    if (direct && !candidates.includes(direct)) candidates.push(direct);
  }

  let lastMediaErr = 'No playable video stream URL found';
  for (const mediaUrl of candidates) {
    try {
      const { buffer } = await fetchBufferWithLimit(mediaUrl, reqHeaders);
      return {
        platform: 'tiktok',
        title,
        author,
        items: [{ kind: 'video', buffer, mimetype: 'video/mp4', filename: 'tiktok-nowm.mp4' }],
      };
    } catch (err) {
      lastMediaErr = (err as Error).message;
    }
  }

  throw new Error(lastMediaErr);
}

async function downloadTikTok(url: string, audioOnly: boolean): Promise<SocialDownloadResult> {
  const resolvedUrl = await resolveFinalUrl(url);
  const candidateUrls = Array.from(new Set([resolvedUrl, url].filter(Boolean)));
  const errors: string[] = [];

  // Tier 1: TikWM (handles watermark-free HD/SD + slideshows + music)
  for (const target of candidateUrls) {
    try {
      const d = await queryTikWm(target);
      if (!d) continue;
      const author = d.author?.nickname || d.author?.unique_id || 'TikTok Creator';
      const title = (d.title || 'TikTok Media').slice(0, 220);

      if (audioOnly && d.music) {
        const musicUrl = normalizeTikWmUrl(d.music);
        if (musicUrl) {
          const { buffer } = await fetchBufferWithLimit(musicUrl, { Referer: 'https://www.tikwm.com/' });
          return {
            platform: 'tiktok',
            title,
            author,
            items: [{ kind: 'audio', buffer, mimetype: 'audio/mpeg', filename: 'tiktok-audio.mp3' }],
          };
        }
      }

      if (Array.isArray(d.images) && d.images.length > 0) {
        const items: DownloadedMediaItem[] = [];
        for (const rawImg of d.images.slice(0, 6)) {
          const imgUrl = normalizeTikWmUrl(rawImg);
          if (!imgUrl) continue;
          const { buffer, contentType } = await fetchBufferWithLimit(imgUrl, { Referer: 'https://www.tikwm.com/' });
          items.push({
            kind: 'image',
            buffer,
            mimetype: contentType.includes('png') ? 'image/png' : 'image/jpeg',
          });
        }
        if (items.length > 0) {
          return { platform: 'tiktok', title, author, items };
        }
      }

      // Try hdplay first, fall back cleanly to watermark-free play if hdplay CDN fails
      const streamCandidates = [d.hdplay, d.play]
        .map((u) => normalizeTikWmUrl(u))
        .filter((u): u is string => Boolean(u));

      for (const streamUrl of streamCandidates) {
        try {
          const { buffer } = await fetchBufferWithLimit(streamUrl, { Referer: 'https://www.tikwm.com/' });
          return {
            platform: 'tiktok',
            title,
            author,
            items: [{ kind: 'video', buffer, mimetype: 'video/mp4', filename: 'tiktok-nowm.mp4' }],
          };
        } catch (streamErr) {
          errors.push(`TikWM stream: ${(streamErr as Error).message}`);
        }
      }
    } catch (err) {
      errors.push(`TikWM: ${(err as Error).message}`);
    }
  }

  // Tier 2: Direct TikTok Webpage Rehydration JSON extractor (verified working with session cookie)
  for (const target of candidateUrls) {
    try {
      return await downloadTikTokFromWebpage(target, audioOnly);
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`Direct TikTok: ${msg}`);
      logger.warn('downloader', `TikTok direct fallback failed for ${target}: ${msg}`);
    }
  }

  // Tier 3: Custom Cobalt instance if user configured COBALT_API_URL
  if (getCobaltEndpoints().length > 0) {
    try {
      const cobalt = await queryCobaltApi({ url: resolvedUrl, audioOnly, videoQuality: '1080' });
      const { buffer, contentType } = await fetchBufferWithLimit(cobalt.mediaUrl);
      return {
        platform: 'tiktok',
        title: 'TikTok No-Watermark',
        items: [
          {
            kind: cobalt.isAudio ? 'audio' : cobalt.isImage ? 'image' : 'video',
            buffer,
            mimetype: cobalt.isAudio ? 'audio/mpeg' : contentType.startsWith('image/') ? contentType : 'video/mp4',
            filename: cobalt.filename,
          },
        ],
      };
    } catch (err) {
      errors.push(`Cobalt: ${(err as Error).message}`);
    }
  }

  throw new Error(errors[errors.length - 1] || 'Could not extract TikTok media from link.');
}

// ============================================================================
// 2. TWITTER / X (Direct HD Video / Images via FxTwitter / VxTwitter)
// ============================================================================
async function downloadTwitter(url: string): Promise<SocialDownloadResult> {
  const resolvedUrl = url.includes('t.co/') ? await resolveFinalUrl(url) : url;
  const statusMatch = resolvedUrl.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
  const errors: string[] = [];

  if (statusMatch) {
    const [, user, statusId] = statusMatch;
    for (const apiHost of ['api.fxtwitter.com', 'api.vxtwitter.com']) {
      try {
        const res = await fetch(`https://${apiHost}/${user}/status/${statusId}`, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          errors.push(`${apiHost}: HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as {
          tweet?: {
            text?: string;
            author?: { name?: string; screen_name?: string };
            media?: {
              videos?: Array<{ url?: string }>;
              photos?: Array<{ url?: string }>;
            };
          };
          text?: string;
          user_name?: string;
          media_extended?: Array<{ type?: string; url?: string }>;
        };

        const videos = data.tweet?.media?.videos || [];
        const photos = data.tweet?.media?.photos || [];
        const vxMedia = data.media_extended || [];

        const title = (data.tweet?.text || data.text || 'X / Twitter Media').slice(0, 220);
        const author =
          data.tweet?.author?.name ||
          (data.tweet?.author?.screen_name ? `@${data.tweet.author.screen_name}` : data.user_name);

        if (videos.length > 0 && videos[0].url) {
          const { buffer } = await fetchBufferWithLimit(videos[0].url);
          return {
            platform: 'twitter',
            title,
            author,
            items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
          };
        }

        if (vxMedia.length > 0) {
          const items: DownloadedMediaItem[] = [];
          for (const m of vxMedia.slice(0, 4)) {
            if (!m.url) continue;
            const { buffer, contentType } = await fetchBufferWithLimit(m.url);
            items.push({
              kind: m.type === 'video' || m.type === 'gif' ? 'video' : 'image',
              buffer,
              mimetype:
                m.type === 'video' || m.type === 'gif'
                  ? 'video/mp4'
                  : contentType.startsWith('image/')
                    ? contentType
                    : 'image/jpeg',
            });
          }
          if (items.length > 0) return { platform: 'twitter', title, author, items };
        }

        if (photos.length > 0) {
          const items: DownloadedMediaItem[] = [];
          for (const p of photos.slice(0, 4)) {
            if (!p.url) continue;
            const { buffer } = await fetchBufferWithLimit(p.url);
            items.push({ kind: 'image', buffer, mimetype: 'image/jpeg' });
          }
          if (items.length > 0) return { platform: 'twitter', title, author, items };
        }
      } catch (err) {
        errors.push(`${apiHost}: ${(err as Error).message}`);
      }
    }
  }

  if (getCobaltEndpoints().length > 0) {
    const cobalt = await queryCobaltApi({ url: resolvedUrl, videoQuality: '1080' });
    const { buffer, contentType } = await fetchBufferWithLimit(cobalt.mediaUrl);
    return {
      platform: 'twitter',
      title: 'X / Twitter Media',
      items: [
        {
          kind: cobalt.isImage ? 'image' : 'video',
          buffer,
          mimetype: cobalt.isImage ? contentType : 'video/mp4',
        },
      ],
    };
  }

  throw new Error(errors[errors.length - 1] || 'No downloadable video or image found on this X/Twitter post.');
}

// ============================================================================
// 3. INSTAGRAM (Reels / Posts / Photos via Embed + GraphQL + Optional Cobalt)
// ============================================================================
async function downloadInstagram(url: string): Promise<SocialDownloadResult> {
  const shortcodeMatch = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  const errors: string[] = [];

  if (shortcodeMatch) {
    const shortcode = shortcodeMatch[1];

    // Tier 1: Instagram Public Embed Page Parser (/reel/... and /p/...)
    for (const kind of ['reel', 'p'] as const) {
      try {
        const embedUrl = `https://www.instagram.com/${kind}/${shortcode}/embed/captioned/`;
        const res = await fetch(embedUrl, {
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.instagram.com/',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          errors.push(`IG embed (${kind}): HTTP ${res.status}`);
          continue;
        }
        const html = await res.text();
        const videoMatch =
          html.match(/"video_url"\s*:\s*"([^"]+)"/i) ||
          html.match(/"playback_url"\s*:\s*"([^"]+)"/i) ||
          html.match(/<video[^>]+src="([^"]+)"/i);
        if (videoMatch?.[1]) {
          const directVideo = unescapeHtmlEntities(videoMatch[1]);
          const { buffer } = await fetchBufferWithLimit(directVideo, { Referer: 'https://www.instagram.com/' });
          return {
            platform: 'instagram',
            title: 'Instagram Reel / Video',
            items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
          };
        }

        const imgMatch =
          html.match(/"display_url"\s*:\s*"([^"]+)"/i) ||
          html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i);
        if (imgMatch?.[1]) {
          const directImg = unescapeHtmlEntities(imgMatch[1]);
          const { buffer } = await fetchBufferWithLimit(directImg, { Referer: 'https://www.instagram.com/' });
          return {
            platform: 'instagram',
            title: 'Instagram Photo',
            items: [{ kind: 'image', buffer, mimetype: 'image/jpeg' }],
          };
        }
      } catch (err) {
        errors.push(`IG embed (${kind}): ${(err as Error).message}`);
      }
    }

    // Tier 2: Instagram Web GraphQL Post Query
    try {
      const gqlBody = new URLSearchParams({
        variables: JSON.stringify({ shortcode }),
        doc_id: '8845758582119845',
      }).toString();
      const gqlRes = await fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          'User-Agent': BROWSER_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-IG-App-ID': '936619743392459',
          Referer: `https://www.instagram.com/p/${shortcode}/`,
        },
        body: gqlBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (gqlRes.ok) {
        const gqlJson = (await gqlRes.json().catch(() => null)) as {
          data?: {
            xdt_shortcode_media?: {
              video_url?: string;
              display_url?: string;
              owner?: { username?: string; full_name?: string };
              edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
              edge_sidecar_to_children?: {
                edges?: Array<{ node?: { is_video?: boolean; video_url?: string; display_url?: string } }>;
              };
            };
          };
        } | null;

        const media = gqlJson?.data?.xdt_shortcode_media;
        if (media) {
          const author = media.owner?.username ? `@${media.owner.username}` : media.owner?.full_name;
          const title = (media.edge_media_to_caption?.edges?.[0]?.node?.text || 'Instagram Media').slice(0, 220);

          if (media.video_url) {
            const { buffer } = await fetchBufferWithLimit(media.video_url);
            return {
              platform: 'instagram',
              title,
              author,
              items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
            };
          }

          const children = media.edge_sidecar_to_children?.edges || [];
          if (children.length > 0) {
            const items: DownloadedMediaItem[] = [];
            for (const c of children.slice(0, 5)) {
              const u = c.node?.video_url || c.node?.display_url;
              if (!u) continue;
              const { buffer } = await fetchBufferWithLimit(u);
              items.push({
                kind: c.node?.is_video ? 'video' : 'image',
                buffer,
                mimetype: c.node?.is_video ? 'video/mp4' : 'image/jpeg',
              });
            }
            if (items.length > 0) {
              return { platform: 'instagram', title, author, items };
            }
          }

          if (media.display_url) {
            const { buffer } = await fetchBufferWithLimit(media.display_url);
            return {
              platform: 'instagram',
              title,
              author,
              items: [{ kind: 'image', buffer, mimetype: 'image/jpeg' }],
            };
          }
        }
      }
    } catch (err) {
      errors.push(`IG GraphQL: ${(err as Error).message}`);
    }
  }

  if (getCobaltEndpoints().length > 0) {
    const cobalt = await queryCobaltApi({ url, videoQuality: '1080' });
    if (cobalt.pickerUrls && cobalt.pickerUrls.length > 0) {
      const items: DownloadedMediaItem[] = [];
      for (const u of cobalt.pickerUrls.slice(0, 5)) {
        const { buffer, contentType } = await fetchBufferWithLimit(u);
        items.push({
          kind: contentType.startsWith('video/') ? 'video' : 'image',
          buffer,
          mimetype: contentType.startsWith('video/') ? 'video/mp4' : 'image/jpeg',
        });
      }
      if (items.length > 0) {
        return { platform: 'instagram', title: 'Instagram Post', items };
      }
    }
    const { buffer, contentType } = await fetchBufferWithLimit(cobalt.mediaUrl);
    return {
      platform: 'instagram',
      title: 'Instagram Reel / Post',
      items: [
        {
          kind: cobalt.isImage || contentType.startsWith('image/') ? 'image' : 'video',
          buffer,
          mimetype: contentType.startsWith('image/') ? contentType : 'video/mp4',
        },
      ],
    };
  }

  throw new Error(errors[errors.length - 1] || 'Could not extract Instagram media (post may be private or rate-limited).');
}

// ============================================================================
// 4. FACEBOOK (HD / SD Direct Stream + mbasic + Optional Cobalt)
// ============================================================================
async function extractFacebookFromHtml(html: string): Promise<SocialDownloadResult | null> {
  const patterns = [
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
    /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/i,
    /"hd_src"\s*:\s*"([^"]+)"/i,
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/i,
    /"playable_url"\s*:\s*"([^"]+)"/i,
    /"sd_src"\s*:\s*"([^"]+)"/i,
    /<meta[^>]+property="og:video(?::url)?"[^>]+content="([^"]+)"/i,
  ];
  for (const rx of patterns) {
    const match = html.match(rx);
    if (match?.[1]) {
      const mediaUrl = unescapeHtmlEntities(match[1]);
      if (mediaUrl.startsWith('http')) {
        try {
          const { buffer } = await fetchBufferWithLimit(mediaUrl);
          const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
          return {
            platform: 'facebook',
            title: titleMatch?.[1]?.replace(/\s*\|\s*Facebook.*$/i, '').trim() || 'Facebook Video',
            items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
          };
        } catch {
          // Try next stream URL candidate
        }
      }
    }
  }
  return null;
}

async function downloadFacebook(url: string): Promise<SocialDownloadResult> {
  const resolvedUrl = await resolveFinalUrl(url);
  const candidatePages = Array.from(
    new Set([
      resolvedUrl,
      resolvedUrl.replace(/^https?:\/\/(?:www\.|m\.)?facebook\.com/i, 'https://mbasic.facebook.com'),
    ])
  );
  const errors: string[] = [];

  for (const pageUrl of candidatePages) {
    try {
      const res = await fetch(pageUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'navigate',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push(`Facebook HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const extracted = await extractFacebookFromHtml(html);
      if (extracted) return extracted;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (getCobaltEndpoints().length > 0) {
    const cobalt = await queryCobaltApi({ url: resolvedUrl, videoQuality: '1080' });
    const { buffer } = await fetchBufferWithLimit(cobalt.mediaUrl);
    return {
      platform: 'facebook',
      title: 'Facebook Video',
      items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
    };
  }

  throw new Error(errors[errors.length - 1] || 'Could not extract Facebook video stream (post may require login).');
}

// ============================================================================
// 5. YOUTUBE (Innertube + Gammacloud Proxy Converter + Optional Cobalt)
// ============================================================================
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtube\.com\/live\/|music\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/i,
  ];
  for (const rx of patterns) {
    const m = url.match(rx);
    if (m?.[1]) return m[1];
  }
  return null;
}

interface InnertubeFormat {
  url?: string;
  mimeType?: string;
  height?: number;
  bitrate?: number;
  contentLength?: string;
}

interface InnertubeResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string };
  streamingData?: {
    formats?: InnertubeFormat[];
    adaptiveFormats?: InnertubeFormat[];
  };
}

function withFullYouTubeRange(streamUrl: string, contentLength?: string): string {
  try {
    const parsed = new URL(streamUrl);
    if (parsed.searchParams.has('range')) return streamUrl;
    const clen = Number(contentLength || parsed.searchParams.get('clen') || 0);
    if (clen > 0 && clen <= MAX_MEDIA_BYTES) {
      parsed.searchParams.set('range', `0-${clen - 1}`);
      return parsed.toString();
    }
  } catch {
    // Keep original URL
  }
  return streamUrl;
}

async function queryYouTubeInnertube(videoId: string): Promise<{ data: InnertubeResponse; userAgent: string }> {
  const clients: Array<{
    userAgent: string;
    context: Record<string, unknown>;
  }> = [
    {
      userAgent: ANDROID_VR_UA,
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.62.27',
          deviceModel: 'Quest 3',
          osName: 'Android',
          osVersion: '12L',
          androidSdkVersion: 32,
          hl: 'en',
          gl: 'US',
        },
      },
    },
    {
      userAgent:
        'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.60.19',
          deviceModel: 'Quest 3',
          osName: 'Android',
          osVersion: '12L',
          androidSdkVersion: 32,
          hl: 'en',
          gl: 'US',
        },
      },
    },
  ];

  let lastReason = 'YouTube player unavailable';
  for (const c of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.userAgent,
          Origin: 'https://www.youtube.com',
        },
        body: JSON.stringify({
          videoId,
          context: c.context,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        lastReason = `YouTube API returned HTTP ${res.status}`;
        continue;
      }

      const data = (await res.json()) as InnertubeResponse;
      if (data.playabilityStatus?.status && data.playabilityStatus.status !== 'OK') {
        lastReason = data.playabilityStatus.reason || data.playabilityStatus.status;
        continue;
      }

      if ((data.streamingData?.formats?.length || 0) > 0 || (data.streamingData?.adaptiveFormats?.length || 0) > 0) {
        return { data, userAgent: c.userAgent };
      }
    } catch (err) {
      lastReason = (err as Error).message;
    }
  }

  throw new Error(lastReason);
}

async function resolveYtmp3GlConfig(): Promise<{
  apiKey: string;
  apiHost: string;
  internalBaseUrl: string;
}> {
  const hdrs = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    Origin: 'https://ytmp3.gl',
    Referer: 'https://ytmp3.gl/',
  };

  const homeRes = await fetch('https://ytmp3.gl/', {
    headers: hdrs,
    signal: AbortSignal.timeout(15_000),
  });
  if (!homeRes.ok) {
    throw new Error(`ytmp3.gl returned HTTP ${homeRes.status}`);
  }
  const html = await homeRes.text();
  const keyMatch = html.match(/decodeKey\(\s*['"]([^'"]+)['"]\s*\)/);
  if (!keyMatch?.[1]) {
    throw new Error('Could not locate converter API key');
  }
  const apiKey = Buffer.from(keyMatch[1].split('').reverse().join(''), 'base64').toString('utf8');

  let apiHost = 'gammacloud.net';
  let internalBaseUrl = 'https://fancy-sea-5d3d.holy-breeze-fec5.workers.dev/?m=i';

  const scriptMatch = html.match(/src=["'](\/js\/[^"']*ytmp3\.js[^"']*)["']/i);
  if (scriptMatch?.[1]) {
    try {
      const jsRes = await fetch(`https://ytmp3.gl${scriptMatch[1]}`, {
        headers: hdrs,
        signal: AbortSignal.timeout(10_000),
      });
      if (jsRes.ok) {
        const js = await jsRes.text();
        const epMatch = js.match(/endpoint\s*=\s*atob\(\s*["']([^"']+)["']\s*\)/);
        if (epMatch?.[1]) {
          const decodedEp = Buffer.from(epMatch[1], 'base64').toString('utf8').trim();
          if (decodedEp) apiHost = decodedEp;
        }
        const intMatch = js.match(/open\(\s*["']GET["']\s*,\s*atob\(\s*["']([^"']+)["']\s*\)/);
        if (intMatch?.[1]) {
          const decodedInt = Buffer.from(intMatch[1], 'base64').toString('utf8').trim();
          if (decodedInt.startsWith('http')) internalBaseUrl = decodedInt;
        }
      }
    } catch {
      // Keep defaults
    }
  }

  return { apiKey, apiHost, internalBaseUrl };
}

async function finishGammaCloudConversion(params: {
  initial: {
    status?: string;
    error?: number | string;
    progressURL?: string;
    downloadURL?: string;
    redirectURL?: string;
    redirect?: number;
    title?: string;
  };
  videoId: string;
  format: 'mp3' | 'mp4';
  headers: Record<string, string>;
}): Promise<{ buffer: Buffer; mimetype: string; title?: string }> {
  let state = params.initial;
  let title = state.title || undefined;

  if (state.redirect === 1 && state.redirectURL) {
    const redirBase = state.redirectURL.split('&v=')[0];
    const redirRes = await fetch(
      `${redirBase}&v=${params.videoId}&f=${params.format}&_=${Date.now()}`,
      { headers: params.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!redirRes.ok) {
      throw new Error(`Redirect convert returned HTTP ${redirRes.status}`);
    }
    state = (await redirRes.json()) as typeof state;
    if (state.title) title = state.title;
    if (Number(state.error) > 0) {
      throw new Error(`Converter redirect error ${state.error}`);
    }
  }

  if (state.progressURL) {
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      const pRes = await fetch(`${state.progressURL}&_=${Date.now()}`, {
        headers: params.headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (pRes.status === 429) {
        throw new Error('Converter rate limit hit (HTTP 429)');
      }
      if (!pRes.ok) {
        throw new Error(`Converter progress returned HTTP ${pRes.status}`);
      }
      const prog = (await pRes.json()) as { progress?: number; error?: number; title?: string };
      if (prog.title) title = prog.title;
      if (Number(prog.error) > 0) {
        throw new Error(`Converter failed with code ${prog.error}`);
      }
      if ((prog.progress || 0) >= 3) {
        break;
      }
    }
  } else if (state.status !== 'download' && state.downloadURL) {
    // Allow brief conversion settle time when no progressURL is provided
    await new Promise((r) => setTimeout(r, 4000));
  }

  if (!state.downloadURL) {
    throw new Error('Converter did not return a download link');
  }

  const finalUrl = `${state.downloadURL}&v=${params.videoId}&f=${params.format}&r=ytmp3.gl`;
  const { buffer, contentType } = await fetchBufferWithLimit(finalUrl, params.headers);
  const mimetype =
    params.format === 'mp3'
      ? 'audio/mpeg'
      : contentType.startsWith('video/')
        ? contentType
        : 'video/mp4';
  return { buffer, mimetype, title };
}

async function queryGammacloudYouTube(
  videoId: string,
  audioOnly: boolean
): Promise<{ buffer: Buffer; mimetype: string; title?: string }> {
  const format: 'mp3' | 'mp4' = audioOnly ? 'mp3' : 'mp4';
  const hdrs: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://ytmp3.gl',
    Referer: 'https://ytmp3.gl/',
  };

  const { apiKey, apiHost, internalBaseUrl } = await resolveYtmp3GlConfig();

  try {
    const authRes = await fetch(
      `https://gamma.${apiHost}/api/v1/auth?api_key=${encodeURIComponent(apiKey)}&_=${Date.now()}`,
      { headers: hdrs, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!authRes.ok) throw new Error(`Auth HTTP ${authRes.status}`);
    const authData = (await authRes.json()) as { key?: string; error?: number | string };
    if (Number(authData.error) > 0 || !authData.key) {
      throw new Error(`Auth error ${authData.error || 'missing token'}`);
    }

    const initRes = await fetch(`https://gamma.${apiHost}/api/v1/init?_=${Date.now()}`, {
      headers: { ...hdrs, Authorization: `Bearer ${authData.key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!initRes.ok) throw new Error(`Init HTTP ${initRes.status}`);
    const initData = (await initRes.json()) as { convertURL?: string; error?: number | string };
    if (Number(initData.error) > 0 || !initData.convertURL) {
      throw new Error(`Init error ${initData.error || 'missing convertURL'}`);
    }

    const convertBase = initData.convertURL.split('&v=')[0];
    const convRes = await fetch(`${convertBase}&v=${videoId}&f=${format}&_=${Date.now()}`, {
      headers: hdrs,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!convRes.ok) throw new Error(`Convert HTTP ${convRes.status}`);
    const convData = (await convRes.json()) as {
      error?: number | string;
      progressURL?: string;
      downloadURL?: string;
      redirectURL?: string;
      redirect?: number;
      title?: string;
      status?: string;
    };
    if (Number(convData.error) > 0) {
      throw new Error(`Convert error ${convData.error}`);
    }

    return await finishGammaCloudConversion({
      initial: convData,
      videoId,
      format,
      headers: hdrs,
    });
  } catch (primaryErr) {
    // Fallback to ytmp3.gl's internal worker endpoint
    const sep = internalBaseUrl.includes('?') ? '&' : '?';
    const workerUrl = `${internalBaseUrl}${sep}k=${encodeURIComponent(apiKey)}&v=${videoId}&f=${format}&_=${Date.now()}`;
    const wRes = await fetch(workerUrl, {
      headers: hdrs,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!wRes.ok) {
      throw primaryErr;
    }
    const wData = (await wRes.json()) as {
      error?: number | string;
      status?: string;
      progressURL?: string;
      downloadURL?: string;
      redirectURL?: string;
      redirect?: number;
      title?: string;
    };
    if (Number(wData.error) > 0 || (!wData.downloadURL && !wData.progressURL && !wData.redirectURL)) {
      throw primaryErr;
    }
    return await finishGammaCloudConversion({
      initial: wData,
      videoId,
      format,
      headers: hdrs,
    });
  }
}

async function queryDavidCyrilYouTube(
  videoId: string,
  audioOnly: boolean
): Promise<{ buffer: Buffer; mimetype: string; title?: string }> {
  const endpoint = audioOnly ? 'ytmp3' : 'ytmp4';
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(
    `https://apis.davidcyriltech.my.id/download/${endpoint}?url=${encodeURIComponent(watchUrl)}`,
    {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new Error(`Extractor API HTTP ${res.status}`);
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    result?: { title?: string; download_url?: string };
  } | null;
  if (!json?.success || !json.result?.download_url) {
    throw new Error(json?.message || 'No YouTube download link returned');
  }
  const { buffer, contentType } = await fetchBufferWithLimit(json.result.download_url);
  return {
    buffer,
    mimetype: audioOnly ? 'audio/mpeg' : contentType.startsWith('video/') ? contentType : 'video/mp4',
    title: json.result.title,
  };
}

async function downloadYouTube(url: string, audioOnly: boolean): Promise<SocialDownloadResult> {
  let title = 'YouTube Media';
  let author: string | undefined;

  const videoId = extractYouTubeId(url);
  if (videoId) {
    try {
      const oembed = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (oembed.ok) {
        const meta = (await oembed.json()) as { title?: string; author_name?: string };
        if (meta.title) title = meta.title;
        if (meta.author_name) author = meta.author_name;
      }
    } catch {
      // Optional metadata
    }
  }

  const errors: string[] = [];

  // Tier 1: Custom Cobalt server if explicitly configured
  if (getCobaltEndpoints().length > 0) {
    try {
      const cobalt = await queryCobaltApi({
        url,
        audioOnly,
        videoQuality: '720',
      });
      const { buffer, contentType } = await fetchBufferWithLimit(cobalt.mediaUrl);
      return {
        platform: 'youtube',
        title,
        author,
        items: [
          {
            kind: audioOnly ? 'audio' : 'video',
            buffer,
            mimetype: audioOnly
              ? 'audio/mpeg'
              : contentType.startsWith('video/')
                ? contentType
                : 'video/mp4',
            filename: cobalt.filename || (audioOnly ? `${title}.mp3` : `${title}.mp4`),
          },
        ],
      };
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`Cobalt: ${msg}`);
      logger.warn('downloader', `Custom Cobalt YouTube fallback failed: ${msg}`);
    }
  }

  if (!videoId) {
    throw new Error('Invalid YouTube URL. Provide a valid youtube.com or youtu.be link.');
  }

  // Tier 2: Direct YouTube Innertube (ANDROID_VR) when IP is not gated
  try {
    const { data: pData, userAgent } = await queryYouTubeInnertube(videoId);
    if (pData.videoDetails?.title) title = pData.videoDetails.title;
    if (pData.videoDetails?.author) author = pData.videoDetails.author;

    const cdnHeaders = { 'User-Agent': userAgent };

    if (audioOnly) {
      const audioCandidates = (pData.streamingData?.adaptiveFormats || [])
        .filter((f) => Boolean(f.url) && (f.mimeType?.startsWith('audio/mp4') || f.mimeType?.startsWith('audio/')))
        .sort((a, b) => {
          const aMp4 = a.mimeType?.startsWith('audio/mp4') ? 1 : 0;
          const bMp4 = b.mimeType?.startsWith('audio/mp4') ? 1 : 0;
          if (aMp4 !== bMp4) return bMp4 - aMp4;
          return (b.bitrate || 0) - (a.bitrate || 0);
        });

      for (const fmt of audioCandidates) {
        if (!fmt.url) continue;
        try {
          const rangedUrl = withFullYouTubeRange(fmt.url, fmt.contentLength);
          const { buffer, contentType } = await fetchBufferWithLimit(rangedUrl, cdnHeaders);
          const isWebm = contentType.includes('webm') || fmt.mimeType?.includes('webm');
          return {
            platform: 'youtube',
            title,
            author,
            items: [
              {
                kind: 'audio',
                buffer,
                mimetype: isWebm ? 'audio/webm' : 'audio/mp4',
                filename: `${title}.${isWebm ? 'webm' : 'm4a'}`,
              },
            ],
          };
        } catch {
          // Try next audio stream
        }
      }
    } else {
      const combined = (pData.streamingData?.formats || [])
        .filter((f) => Boolean(f.url))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const ordered = [
        ...combined.filter((f) => (f.height || 0) <= 720),
        ...combined.filter((f) => (f.height || 0) > 720),
      ];

      for (const fmt of ordered) {
        if (!fmt.url) continue;
        try {
          const rangedUrl = withFullYouTubeRange(fmt.url, fmt.contentLength);
          const { buffer } = await fetchBufferWithLimit(rangedUrl, cdnHeaders);
          return {
            platform: 'youtube',
            title,
            author,
            items: [{ kind: 'video', buffer, mimetype: 'video/mp4', filename: `${title}.mp4` }],
          };
        } catch {
          // Try next quality format
        }
      }
    }
  } catch (err) {
    errors.push(`Innertube: ${(err as Error).message}`);
  }

  // Tier 3: Proxied MP4/MP3 converter (works for Shorts & standard videos on cloud/datacenter IPs)
  try {
    const gamma = await queryGammacloudYouTube(videoId, audioOnly);
    return {
      platform: 'youtube',
      title: gamma.title || title,
      author,
      items: [
        {
          kind: audioOnly ? 'audio' : 'video',
          buffer: gamma.buffer,
          mimetype: gamma.mimetype,
          filename: `${gamma.title || title}.${audioOnly ? 'mp3' : 'mp4'}`,
        },
      ],
    };
  } catch (err) {
    const msg = (err as Error).message;
    errors.push(`Converter: ${msg}`);
    logger.warn('downloader', `YouTube converter tier failed for ${videoId}: ${msg}`);
  }

  // Tier 4: Backup REST extractor (verifies stream is actually downloadable before succeeding)
  try {
    const dc = await queryDavidCyrilYouTube(videoId, audioOnly);
    return {
      platform: 'youtube',
      title: dc.title || title,
      author,
      items: [
        {
          kind: audioOnly ? 'audio' : 'video',
          buffer: dc.buffer,
          mimetype: dc.mimetype,
          filename: `${dc.title || title}.${audioOnly ? 'mp3' : 'mp4'}`,
        },
      ],
    };
  } catch (err) {
    errors.push(`Fallback: ${(err as Error).message}`);
  }

  throw new Error(errors[errors.length - 1] || 'Could not download YouTube video or audio.');
}

// ============================================================================
// 6. PINTEREST (HD Video & Original Images)
// ============================================================================
function cleanPinterestMediaUrl(rawUrl: string): string {
  return unescapeHtmlEntities(rawUrl)
    .trim()
    .replace(/[),;'"\\]+$/, '');
}

function isJunkPinterestAsset(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  if (!lower.startsWith('http')) return true;
  // Filter out Pinterest UI icons, gradient button assets, favicons, avatars, tiny thumbnails
  return (
    lower.includes('d53b014d86a6b6761bf649a0ed813c2b') ||
    lower.includes('/webapp/') ||
    lower.includes('favicon') ||
    lower.includes('apple-touch-icon') ||
    lower.includes('sprite') ||
    lower.includes('/assets/') ||
    lower.includes('logo') ||
    lower.includes('/75x75') ||
    lower.includes('/140x140') ||
    lower.includes('/avatars/')
  );
}

function extractPinterestVideoCandidates(html: string): string[] {
  const normalized = unescapeHtmlEntities(html);
  const candidates: string[] = [];
  const push = (u: string) => {
    const cleaned = cleanPinterestMediaUrl(u);
    if (cleaned.startsWith('http') && !isJunkPinterestAsset(cleaned) && !candidates.includes(cleaned)) {
      candidates.push(cleaned);
    }
  };

  // 1. Direct MP4 URLs ordered from highest to lowest quality
  for (const rx of [
    /https:\/\/v\d*\.pinimg\.com\/videos\/mc\/720p\/[a-f0-9/]+\.mp4/gi,
    /https:\/\/v\d*\.pinimg\.com\/videos\/iht\/720p\/[a-f0-9/]+\.mp4/gi,
    /https:\/\/v\d*\.pinimg\.com\/videos\/mc\/[^"'\s\\)]+\.mp4/gi,
    /https:\/\/v\d*\.pinimg\.com\/videos\/iht\/expMp4\/[a-f0-9/]+(?:_t1)?\.mp4/gi,
    /https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\)]+\.mp4/gi,
  ]) {
    for (const m of normalized.matchAll(rx)) {
      push(m[0]);
    }
  }

  const ogVideo =
    normalized.match(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    normalized.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1];
  if (ogVideo) push(ogVideo);

  // 2. Reconstruct 720p MP4 stream URLs from any HLS (.m3u8), expMp4, or video thumbnail hash
  const hashRx =
    /pinimg\.com\/videos\/(?:mc|iht|hls|thumbnails)\/(?:720p|480p|360p|expMp4|hls|originals)\/([a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+)/gi;
  for (const m of normalized.matchAll(hashRx)) {
    const hash = m[1];
    if (hash) {
      push(`https://v1.pinimg.com/videos/mc/720p/${hash}.mp4`);
      push(`https://v1.pinimg.com/videos/iht/720p/${hash}.mp4`);
    }
  }

  return candidates;
}

function extractPinterestImageCandidates(html: string): string[] {
  const normalized = unescapeHtmlEntities(html);
  const candidates: string[] = [];
  const push = (u: string) => {
    const cleaned = cleanPinterestMediaUrl(u);
    if (cleaned.startsWith('http') && !isJunkPinterestAsset(cleaned) && !candidates.includes(cleaned)) {
      candidates.push(cleaned);
    }
  };

  for (const rx of [
    /["'](https:\/\/i\.pinimg\.com\/originals\/[a-f0-9/]+\.(?:jpg|jpeg|png|webp))["']/gi,
    /https:\/\/i\.pinimg\.com\/originals\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/i\.pinimg\.com\/(?:1200x|736x|564x)\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]+\.(?:jpg|jpeg|png|webp)/gi,
  ]) {
    for (const m of normalized.matchAll(rx)) {
      push(m[1] || m[0]);
    }
  }

  const ogImg =
    normalized.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    normalized.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (ogImg) push(ogImg);

  return candidates;
}

function extractPinterestTitle(html: string): string {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim();
  if (ogTitle && ogTitle.toLowerCase() !== 'pinterest') return ogTitle.slice(0, 200);
  const tagTitle = html.match(/<title>([^<]+)<\/title>/i)?.[1]
    ?.replace(/\s*[|\-–]\s*Pinterest.*$/i, '')
    .trim();
  if (tagTitle && tagTitle.toLowerCase() !== 'pinterest') return tagTitle.slice(0, 200);
  return 'Pinterest Pin';
}

async function downloadPinterest(url: string): Promise<SocialDownloadResult> {
  // Fetch the submitted URL ONCE directly (avoid double-hitting pin.it -> /sent/ which can strip video metadata)
  const primaryRes = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!primaryRes.ok) {
    throw new Error(`Pinterest returned HTTP ${primaryRes.status}`);
  }

  const resolvedUrl = (primaryRes.url || url).split('#')[0];
  const primaryHtml = await primaryRes.text();
  let title = extractPinterestTitle(primaryHtml);

  const pinIdMatch =
    resolvedUrl.match(/\/pin\/(\d+)/i) ||
    primaryHtml.match(/https:\/\/(?:www\.)?pinterest\.[^/"'\s]+\/pin\/(\d+)/i);
  const cleanPinUrl = pinIdMatch?.[1] ? `https://www.pinterest.com/pin/${pinIdMatch[1]}/` : resolvedUrl;

  const htmlSources: string[] = [primaryHtml];

  // Try video candidates from primary HTML first
  for (const videoUrl of extractPinterestVideoCandidates(primaryHtml)) {
    try {
      const { buffer, contentType } = await fetchBufferWithLimit(videoUrl);
      if (contentType.startsWith('video/') || videoUrl.endsWith('.mp4')) {
        return {
          platform: 'pinterest',
          title,
          items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
        };
      }
    } catch {
      // Try next video candidate
    }
  }

  // Secondary fetch: clean Pin URL with crawler UA often exposes full og/video JSON even when /sent/ omits it
  if (pinIdMatch?.[1]) {
    try {
      const botRes = await fetch(cleanPinUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (botRes.ok) {
        const botHtml = await botRes.text();
        htmlSources.push(botHtml);
        if (title === 'Pinterest Pin') title = extractPinterestTitle(botHtml);
        for (const videoUrl of extractPinterestVideoCandidates(botHtml)) {
          try {
            const { buffer } = await fetchBufferWithLimit(videoUrl);
            return {
              platform: 'pinterest',
              title,
              items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
            };
          } catch {
            // Try next candidate
          }
        }
      }
    } catch {
      // Proceed to SavePin fallback
    }
  }

  // Tertiary fetch: SavePin extractor exposes video thumbnail hashes or direct MP4/image links
  try {
    const spRes = await fetch(
      `https://www.savepin.app/download.php?url=${encodeURIComponent(cleanPinUrl)}&lang=en&type=redirect`,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Referer: 'https://www.savepin.app/',
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (spRes.ok) {
      const spHtml = await spRes.text();
      htmlSources.push(spHtml);
      for (const videoUrl of extractPinterestVideoCandidates(spHtml)) {
        try {
          const { buffer } = await fetchBufferWithLimit(videoUrl);
          return {
            platform: 'pinterest',
            title,
            items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
          };
        } catch {
          // Try next candidate
        }
      }
    }
  } catch {
    // Proceed to high-res image extraction
  }

  // If no video exists, fall back to clean high-resolution Pin images (never UI icons!)
  for (const html of htmlSources) {
    for (const imgUrl of extractPinterestImageCandidates(html)) {
      try {
        const { buffer, contentType } = await fetchBufferWithLimit(imgUrl);
        if (!contentType.startsWith('image/')) continue;
        return {
          platform: 'pinterest',
          title,
          items: [
            {
              kind: 'image',
              buffer,
              mimetype: contentType,
            },
          ],
        };
      } catch {
        // Try next image candidate
      }
    }
  }

  if (getCobaltEndpoints().length > 0) {
    const cobalt = await queryCobaltApi({ url: cleanPinUrl, videoQuality: '1080' });
    const { buffer, contentType } = await fetchBufferWithLimit(cobalt.mediaUrl);
    return {
      platform: 'pinterest',
      title,
      items: [
        {
          kind: contentType.startsWith('image/') ? 'image' : 'video',
          buffer,
          mimetype: contentType.startsWith('image/') ? contentType : 'video/mp4',
        },
      ],
    };
  }

  throw new Error('Could not find downloadable video or image on this Pinterest Pin.');
}

export async function downloadSocialMedia(params: {
  platform: SocialPlatform;
  url: string;
  audioOnly?: boolean;
}): Promise<SocialDownloadResult> {
  const { platform, url, audioOnly = false } = params;

  const quota = checkPlatformDownloadQuota(platform);
  if (!quota.allowed) {
    throw new Error(`Rate limit active for ${platform} downloads. Wait ${quota.waitSec}s and try again.`);
  }

  switch (platform) {
    case 'tiktok':
      return downloadTikTok(url, audioOnly);
    case 'twitter':
      return downloadTwitter(url);
    case 'instagram':
      return downloadInstagram(url);
    case 'facebook':
      return downloadFacebook(url);
    case 'youtube':
      return downloadYouTube(url, audioOnly);
    case 'pinterest':
      return downloadPinterest(url);
  }
}
