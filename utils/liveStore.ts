import fs from 'fs';
import path from 'path';
import {
  dbGetSync,
  dbSeedSync,
  dbSetSync,
  migrateLegacyJsonIfMissing,
  registerDbHydrationHook,
  resolveDataDir,
} from './db.ts';

export type LiveMediaType = 'none' | 'image' | 'video';
export type AlertLevel = 'info' | 'important' | 'urgent';

export interface LiveScreenState {
  active: boolean;
  title: string;
  message: string;
  mediaType: LiveMediaType;
  mediaUrl: string;
  updatedAt: string;
}

export interface PortalBannerState {
  enabled: boolean;
  mediaType: LiveMediaType;
  mediaUrl: string;
  caption: string;
  updatedAt: string;
}

export interface AdminAlert {
  id: string;
  title: string;
  message: string;
  level: AlertLevel;
  createdAt: string;
}

const dbDir = resolveDataDir();
const mediaDir = path.join(dbDir, 'media');
const liveScreenFile = path.join(dbDir, 'live_screen.json');
const alertsFile = path.join(dbDir, 'notifications.json');

const defaultLiveScreen: LiveScreenState = {
  active: true,
  title: 'FADI KING MD Live Broadcast',
  message: 'Authorized VIP numbers can pair 24/7 using an 8-digit pairing code or QR scan.',
  mediaType: 'none',
  mediaUrl: '',
  updatedAt: new Date().toISOString(),
};

const defaultPortalBanner: PortalBannerState = {
  enabled: false,
  mediaType: 'none',
  mediaUrl: '',
  caption: '',
  updatedAt: new Date().toISOString(),
};

let storageInitialized = false;
let liveScreenCache: LiveScreenState | null = null;
let portalBannerCache: PortalBannerState | null = null;
let alertsCache: AdminAlert[] | null = null;

registerDbHydrationHook(() => {
  liveScreenCache = null;
  portalBannerCache = null;
  alertsCache = null;
});

function ensureStorage(): void {
  if (storageInitialized) return;
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  storageInitialized = true;
}

export const liveStore = {
  getMediaDir(): string {
    ensureStorage();
    return mediaDir;
  },

  getLiveScreen(): LiveScreenState {
    if (liveScreenCache) return liveScreenCache;
    ensureStorage();
    const fromDb =
      dbGetSync<LiveScreenState>('live_screen') ??
      migrateLegacyJsonIfMissing<LiveScreenState>('live_screen', liveScreenFile);
    if (fromDb) {
      liveScreenCache = fromDb;
      return liveScreenCache;
    }
    liveScreenCache = { ...defaultLiveScreen };
    dbSeedSync('live_screen', liveScreenCache);
    return liveScreenCache;
  },

  updateLiveScreen(patch: Partial<LiveScreenState>): LiveScreenState {
    ensureStorage();
    const current = this.getLiveScreen();
    const mediaType: LiveMediaType =
      patch.mediaType === 'image' || patch.mediaType === 'video' || patch.mediaType === 'none'
        ? patch.mediaType
        : current.mediaType;

    const next: LiveScreenState = {
      active: typeof patch.active === 'boolean' ? patch.active : current.active,
      title: typeof patch.title === 'string' ? patch.title.trim() : current.title,
      message: typeof patch.message === 'string' ? patch.message.trim() : current.message,
      mediaType,
      mediaUrl: typeof patch.mediaUrl === 'string' ? patch.mediaUrl.trim() : current.mediaUrl,
      updatedAt: new Date().toISOString(),
    };
    liveScreenCache = next;
    dbSetSync('live_screen', next);
    return next;
  },

  getPortalBanner(): PortalBannerState {
    if (portalBannerCache) return portalBannerCache;
    ensureStorage();
    const fromDb = dbGetSync<PortalBannerState>('portal_banner');
    if (fromDb) {
      portalBannerCache = fromDb;
      return portalBannerCache;
    }
    portalBannerCache = { ...defaultPortalBanner };
    dbSeedSync('portal_banner', portalBannerCache);
    return portalBannerCache;
  },

  updatePortalBanner(patch: Partial<PortalBannerState>): PortalBannerState {
    ensureStorage();
    const current = this.getPortalBanner();
    const mediaType: LiveMediaType =
      patch.mediaType === 'image' || patch.mediaType === 'video' || patch.mediaType === 'none'
        ? patch.mediaType
        : current.mediaType;

    const next: PortalBannerState = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      mediaType,
      mediaUrl: typeof patch.mediaUrl === 'string' ? patch.mediaUrl.trim() : current.mediaUrl,
      caption: typeof patch.caption === 'string' ? patch.caption.trim() : current.caption,
      updatedAt: new Date().toISOString(),
    };
    portalBannerCache = next;
    dbSetSync('portal_banner', next);
    return next;
  },

  getAlerts(limit = 30): AdminAlert[] {
    if (alertsCache) return alertsCache.slice(0, limit);
    ensureStorage();
    const fromDb =
      dbGetSync<AdminAlert[]>('alerts') ??
      migrateLegacyJsonIfMissing<AdminAlert[]>('alerts', alertsFile);
    if (Array.isArray(fromDb)) {
      alertsCache = fromDb;
      return alertsCache.slice(0, limit);
    }
    alertsCache = [];
    dbSeedSync('alerts', alertsCache);
    return [];
  },

  addAlert(input: { title: string; message: string; level?: AlertLevel }): AdminAlert {
    ensureStorage();
    const list = [...this.getAlerts(100)];
    const created: AdminAlert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: input.title.trim() || 'Admin Notice',
      message: input.message.trim(),
      level:
        input.level === 'urgent' || input.level === 'important' ? input.level : 'info',
      createdAt: new Date().toISOString(),
    };
    list.unshift(created);
    if (list.length > 50) list.length = 50;
    alertsCache = list;
    dbSetSync('alerts', list);
    return created;
  },

  deleteAlert(id: string): void {
    ensureStorage();
    const list = this.getAlerts(100).filter((a) => a.id !== id);
    alertsCache = list;
    dbSetSync('alerts', list);
  },

  clearAlerts(): void {
    ensureStorage();
    alertsCache = [];
    dbSetSync('alerts', []);
  },

  saveUploadedMedia(base64Data: string, mimeType: string): { filename: string; url: string } {
    ensureStorage();
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
    };
    const ext = extMap[mimeType.toLowerCase()];
    if (!ext) {
      throw new Error('Unsupported media format. Upload JPG, PNG, WebP, GIF, MP4, or WebM.');
    }

    const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.length > 25 * 1024 * 1024) {
      throw new Error('Media file exceeds 25MB limit.');
    }

    const filename = `live_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    fs.writeFileSync(path.join(mediaDir, filename), buffer);
    if (buffer.length <= 8 * 1024 * 1024) {
      dbSetSync(`media_blob:${filename}`, {
        mimeType: mimeType.toLowerCase(),
        base64: buffer.toString('base64'),
      });
    }
    return {
      filename,
      url: `/api/public/media/${filename}`,
    };
  },

  readPersistedMedia(filename: string): { mimeType: string; buffer: Buffer } | null {
    const safeName = path.basename(filename || '');
    if (!safeName) return null;
    const saved = dbGetSync<{ mimeType: string; base64: string }>(`media_blob:${safeName}`);
    if (!saved?.base64) return null;
    return {
      mimeType: saved.mimeType || 'application/octet-stream',
      buffer: Buffer.from(saved.base64, 'base64'),
    };
  },
};
