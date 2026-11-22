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
const DOWNLOAD_TIMEOUT_MS = 45_000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

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

  const contentLen = Number(res.headers.get('content-length') || 0);
  if (contentLen > maxBytes) {
    throw new Error(
      `File is too large (${(contentLen / (1024 * 1024)).toFixed(1)} MB). Max safe limit is ${Math.round(
        maxBytes / (1024 * 1024)
      )} MB.`
    );
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  if (!res.body) {
    const arr = await res.arrayBuffer();
    if (arr.byteLength > maxBytes) {
      throw new Error(`File exceeded ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`);
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

  return {
    buffer: Buffer.concat(chunks),
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
  const list = [
    custom,
    'https://api.cobalt.tools',
    'https://cobalt-api.kwiatekmiki.com',
  ].filter((v): v is string => Boolean(v));
  return Array.from(new Set(list.map((u) => u.replace(/\/+$/, ''))));
}

async function queryCobaltApi(params: {
  url: string;
  audioOnly?: boolean;
  videoQuality?: string;
}): Promise<{ mediaUrl: string; filename?: string; isAudio: boolean; isImage: boolean; pickerUrls?: string[] }> {
  const endpoints = getCobaltEndpoints();
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

      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': BROWSER_UA,
        },
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
// 1. TIKTOK (Watermark-Free Video + Photo Slideshows via TikWM + Cobalt)
// ============================================================================
async function downloadTikTok(url: string, audioOnly: boolean): Promise<SocialDownloadResult> {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: {
        title?: string;
        author?: { nickname?: string; unique_id?: string };
        hdplay?: string;
        play?: string;
        music?: string;
        images?: string[];
      };
    };

    if (json?.code === 0 && json.data) {
      const d = json.data;
      const author = d.author?.nickname || d.author?.unique_id || 'TikTok Creator';
      const title = (d.title || 'TikTok Media').slice(0, 220);

      if (audioOnly && d.music) {
        const { buffer } = await fetchBufferWithLimit(d.music);
        return {
          platform: 'tiktok',
          title,
          author,
          items: [{ kind: 'audio', buffer, mimetype: 'audio/mpeg', filename: 'tiktok-audio.mp3' }],
        };
      }

      if (Array.isArray(d.images) && d.images.length > 0) {
        const items: DownloadedMediaItem[] = [];
        for (const imgUrl of d.images.slice(0, 6)) {
          const { buffer, contentType } = await fetchBufferWithLimit(imgUrl);
          items.push({
            kind: 'image',
            buffer,
            mimetype: contentType.includes('png') ? 'image/png' : 'image/jpeg',
          });
        }
        return { platform: 'tiktok', title, author, items };
      }

      const videoUrl = d.hdplay || d.play;
      if (videoUrl) {
        const { buffer } = await fetchBufferWithLimit(videoUrl);
        return {
          platform: 'tiktok',
          title,
          author,
          items: [{ kind: 'video', buffer, mimetype: 'video/mp4', filename: 'tiktok-nowm.mp4' }],
        };
      }
    }
  } catch (err) {
    logger.warn('downloader', `TikWM fallback for ${url}: ${(err as Error).message}`);
  }

  const cobalt = await queryCobaltApi({ url, audioOnly, videoQuality: '1080' });
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
}

// ============================================================================
// 2. TWITTER / X (Direct HD Video / Images via FxTwitter / VxTwitter)
// ============================================================================
async function downloadTwitter(url: string): Promise<SocialDownloadResult> {
  const statusMatch = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
  if (statusMatch) {
    const [, user, statusId] = statusMatch;
    for (const apiHost of ['api.fxtwitter.com', 'api.vxtwitter.com']) {
      try {
        const res = await fetch(`https://${apiHost}/${user}/status/${statusId}`, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) continue;
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
      } catch {
        // Try next API
      }
    }
  }

  const cobalt = await queryCobaltApi({ url, videoQuality: '1080' });
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

// ============================================================================
// 3. INSTAGRAM (Reels / Posts / Photos via Embed Parser + Cobalt Fallback)
// ============================================================================
async function downloadInstagram(url: string): Promise<SocialDownloadResult> {
  // Try clean Cobalt API first
  try {
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
  } catch {
    // Fallback to public embed page parser
  }

  const shortcodeMatch = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (shortcodeMatch) {
    const embedUrl = `https://www.instagram.com/p/${shortcodeMatch[1]}/embed/captioned/`;
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const html = await res.text();
      const videoMatch =
        html.match(/"video_url"\s*:\s*"([^"]+)"/i) ||
        html.match(/<video[^>]+src="([^"]+)"/i);
      if (videoMatch?.[1]) {
        const directVideo = unescapeHtmlEntities(videoMatch[1]);
        const { buffer } = await fetchBufferWithLimit(directVideo);
        return {
          platform: 'instagram',
          title: 'Instagram Video',
          items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
        };
      }

      const imgMatch =
        html.match(/"display_url"\s*:\s*"([^"]+)"/i) ||
        html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i);
      if (imgMatch?.[1]) {
        const directImg = unescapeHtmlEntities(imgMatch[1]);
        const { buffer } = await fetchBufferWithLimit(directImg);
        return {
          platform: 'instagram',
          title: 'Instagram Photo',
          items: [{ kind: 'image', buffer, mimetype: 'image/jpeg' }],
        };
      }
    }
  }

  throw new Error('Could not extract Instagram media (post may be private or rate-limited).');
}

// ============================================================================
// 4. FACEBOOK (HD / SD Direct Stream + Cobalt Fallback)
// ============================================================================
async function downloadFacebook(url: string): Promise<SocialDownloadResult> {
  try {
    const res = await fetch(url, {
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

    if (res.ok) {
      const html = await res.text();
      const patterns = [
        /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
        /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
        /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/i,
        /"hd_src"\s*:\s*"([^"]+)"/i,
        /"browser_native_sd_url"\s*:\s*"([^"]+)"/i,
        /"playable_url"\s*:\s*"([^"]+)"/i,
        /"sd_src"\s*:\s*"([^"]+)"/i,
      ];
      for (const rx of patterns) {
        const match = html.match(rx);
        if (match?.[1]) {
          const mediaUrl = unescapeHtmlEntities(match[1]);
          if (mediaUrl.startsWith('http')) {
            const { buffer } = await fetchBufferWithLimit(mediaUrl);
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            return {
              platform: 'facebook',
              title: titleMatch?.[1]?.replace(/\s*\|\s*Facebook.*$/i, '').trim() || 'Facebook Video',
              items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
            };
          }
        }
      }
    }
  } catch {
    // Fall back to Cobalt
  }

  const cobalt = await queryCobaltApi({ url, videoQuality: '1080' });
  const { buffer } = await fetchBufferWithLimit(cobalt.mediaUrl);
  return {
    platform: 'facebook',
    title: 'Facebook Video',
    items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
  };
}

// ============================================================================
// 5. YOUTUBE (MP4 Video / MP3 Audio via Cobalt + Innertube Fallback)
// ============================================================================
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/|music\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/i,
  ];
  for (const rx of patterns) {
    const m = url.match(rx);
    if (m?.[1]) return m[1];
  }
  return null;
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
  } catch (cobaltErr) {
    // Fallback to YouTube Innertube Android/iOS player API
    if (videoId) {
      try {
        const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: 'IOS',
                clientVersion: '19.29.1',
                deviceModel: 'iPhone16,2',
                hl: 'en',
                gl: 'US',
              },
            },
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (playerRes.ok) {
          const pData = (await playerRes.json()) as {
            videoDetails?: { title?: string; author?: string };
            streamingData?: {
              formats?: Array<{ url?: string; mimeType?: string; height?: number }>;
              adaptiveFormats?: Array<{ url?: string; mimeType?: string; bitrate?: number }>;
            };
          };
          if (pData.videoDetails?.title) title = pData.videoDetails.title;
          if (pData.videoDetails?.author) author = pData.videoDetails.author;

          if (audioOnly) {
            const audioFmt = (pData.streamingData?.adaptiveFormats || []).find(
              (f) => f.url && f.mimeType?.startsWith('audio/mp4')
            );
            if (audioFmt?.url) {
              const { buffer } = await fetchBufferWithLimit(audioFmt.url);
              return {
                platform: 'youtube',
                title,
                author,
                items: [{ kind: 'audio', buffer, mimetype: 'audio/mp4', filename: `${title}.m4a` }],
              };
            }
          } else {
            const combined = (pData.streamingData?.formats || [])
              .filter((f) => Boolean(f.url))
              .sort((a, b) => (b.height || 0) - (a.height || 0));
            const best = combined.find((f) => (f.height || 0) <= 720) || combined[0];
            if (best?.url) {
              const { buffer } = await fetchBufferWithLimit(best.url);
              return {
                platform: 'youtube',
                title,
                author,
                items: [{ kind: 'video', buffer, mimetype: 'video/mp4', filename: `${title}.mp4` }],
              };
            }
          }
        }
      } catch {
        // Fall through to throw original reason
      }
    }
    throw new Error(`YouTube download failed: ${(cobaltErr as Error).message}`);
  }
}

// ============================================================================
// 6. PINTEREST (HD Video & Original Images)
// ============================================================================
async function downloadPinterest(url: string): Promise<SocialDownloadResult> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Pinterest returned HTTP ${res.status}`);
  }
  const html = await res.text();

  const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  const title = titleMatch?.[1]?.trim() || 'Pinterest Pin';

  // Prefer MP4 video stream over thumbnail image
  const videoUrls = Array.from(
    html.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/mc\/720p\/[^"'\s\\]+\.mp4/gi)
  ).map((m) => m[0]);
  const hqVideoFallback = Array.from(
    html.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\]+\.mp4/gi)
  ).map((m) => m[0]);
  const pickedVideo = videoUrls[0] || hqVideoFallback[0];

  if (pickedVideo) {
    const { buffer } = await fetchBufferWithLimit(pickedVideo);
    return {
      platform: 'pinterest',
      title,
      items: [{ kind: 'video', buffer, mimetype: 'video/mp4' }],
    };
  }

  // Fallback to highest-res pinimg image
  const origImgs = Array.from(
    html.matchAll(/https:\/\/i\.pinimg\.com\/originals\/[^"'\s\\]+\.(?:jpg|jpeg|png|webp)/gi)
  ).map((m) => m[0]);
  const ogImg = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1];
  const imgUrl = origImgs[0] || ogImg;

  if (imgUrl) {
    const { buffer, contentType } = await fetchBufferWithLimit(imgUrl);
    return {
      platform: 'pinterest',
      title,
      items: [
        {
          kind: 'image',
          buffer,
          mimetype: contentType.startsWith('image/') ? contentType : 'image/jpeg',
        },
      ],
    };
  }

  const cobalt = await queryCobaltApi({ url, videoQuality: '1080' });
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
