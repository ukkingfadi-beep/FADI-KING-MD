import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  BellRing,
  Image as ImageIcon,
  MonitorPlay,
  Send,
  Trash2,
  Upload,
  Video,
} from 'lucide-react';
import type {
  AdminAlert,
  AlertLevel,
  LiveMediaType,
  LiveScreenState,
  PortalBannerState,
} from '../types/bot';

interface LiveScreenAdminProps {
  portalBanner: PortalBannerState | null;
  liveScreen: LiveScreenState | null;
  alerts: AdminAlert[];
  adminToken: string;
  onRefresh: () => Promise<void>;
}

export function LiveScreenAdmin({
  portalBanner,
  liveScreen,
  alerts,
  adminToken,
  onRefresh,
}: LiveScreenAdminProps) {
  const [bannerEnabled, setBannerEnabled] = useState(false);
  const [bannerType, setBannerType] = useState<LiveMediaType>('none');
  const [bannerUrl, setBannerUrl] = useState('');
  const [bannerCaption, setBannerCaption] = useState('');
  const [savingBanner, setSavingBanner] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [bannerFeedback, setBannerFeedback] = useState<string | null>(null);

  const [active, setActive] = useState(true);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [mediaType, setMediaType] = useState<LiveMediaType>('none');
  const [mediaUrl, setMediaUrl] = useState('');
  const [savingScreen, setSavingScreen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [screenFeedback, setScreenFeedback] = useState<string | null>(null);

  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('important');
  const [sendingAlert, setSendingAlert] = useState(false);
  const [alertFeedback, setAlertFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (portalBanner) {
      setBannerEnabled(portalBanner.enabled);
      setBannerType(portalBanner.mediaType);
      setBannerUrl(portalBanner.mediaUrl);
      setBannerCaption(portalBanner.caption || '');
    }
  }, [portalBanner]);

  useEffect(() => {
    if (liveScreen) {
      setActive(liveScreen.active);
      setTitle(liveScreen.title);
      setMessage(liveScreen.message);
      setMediaType(liveScreen.mediaType);
      setMediaUrl(liveScreen.mediaUrl);
    }
  }, [liveScreen]);

  async function handleSaveBanner(e: FormEvent) {
    e.preventDefault();
    setSavingBanner(true);
    setBannerFeedback(null);
    try {
      const res = await fetch('/api/admin/portal-banner', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          enabled: bannerEnabled,
          mediaType: bannerType,
          mediaUrl: bannerUrl,
          caption: bannerCaption,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setBannerFeedback('Top Portal Header Banner saved to persistent database.');
        await onRefresh();
      } else {
        setBannerFeedback(data.error || 'Failed to update Portal Banner.');
      }
    } finally {
      setSavingBanner(false);
    }
  }

  async function handleBannerUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBanner(true);
    setBannerFeedback(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/admin/upload-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ dataUrl, mimeType: file.type }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setBannerUrl(data.url);
        setBannerType(file.type.startsWith('video/') ? 'video' : 'image');
        setBannerEnabled(true);
        setBannerFeedback(`Uploaded ${file.name}. Click "Save Header Banner" to apply on the pairing portal.`);
      } else {
        setBannerFeedback(data.error || 'Upload failed.');
      }
    } catch (err) {
      setBannerFeedback((err as Error).message);
    } finally {
      setUploadingBanner(false);
    }
  }

  async function handleSaveScreen(e: FormEvent) {
    e.preventDefault();
    setSavingScreen(true);
    setScreenFeedback(null);
    try {
      const res = await fetch('/api/admin/live-screen', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ active, title, message, mediaType, mediaUrl }),
      });
      const data = await res.json();
      if (data.ok) {
        setScreenFeedback('Public Live Screen updated immediately.');
        await onRefresh();
      } else {
        setScreenFeedback(data.error || 'Failed to update Live Screen.');
      }
    } finally {
      setSavingScreen(false);
    }
  }

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setScreenFeedback(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/admin/upload-media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ dataUrl, mimeType: file.type }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setMediaUrl(data.url);
        setMediaType(file.type.startsWith('video/') ? 'video' : 'image');
        setScreenFeedback(`Uploaded ${file.name}. Click "Publish Live Screen" to push live.`);
      } else {
        setScreenFeedback(data.error || 'Upload failed.');
      }
    } catch (err) {
      setScreenFeedback((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleSendAlert(e: FormEvent) {
    e.preventDefault();
    if (!alertMessage.trim()) return;
    setSendingAlert(true);
    setAlertFeedback(null);
    try {
      const res = await fetch('/api/admin/alerts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          title: alertTitle.trim() || 'Admin Alert',
          message: alertMessage.trim(),
          level: alertLevel,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setAlertTitle('');
        setAlertMessage('');
        setAlertFeedback('Bell Notification sent to all public users.');
        await onRefresh();
      } else {
        setAlertFeedback(data.error || 'Failed to send alert.');
      }
    } finally {
      setSendingAlert(false);
    }
  }

  async function handleDeleteAlert(id: string) {
    await fetch(`/api/admin/alerts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await onRefresh();
  }

  async function handleClearAlerts() {
    await fetch('/api/admin/alerts', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await onRefresh();
  }

  return (
    <div className="space-y-8">
      {/* Dynamic Top Header Media Banner Controller */}
      <section className="glass-surface rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <ImageIcon className="w-4 h-4 text-[#A78BFA]" />
            <div>
              <h2 className="text-lg font-semibold text-white">Top Pairing Portal Banner (Photo / Video)</h2>
              <p className="text-xs text-[#9E97C2]">
                Upload or link a photo/video to show at the very top of the public pairing portal.
              </p>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-white cursor-pointer">
            <input
              type="checkbox"
              checked={bannerEnabled}
              onChange={(e) => setBannerEnabled(e.target.checked)}
              className="w-4 h-4 accent-[#8B5CF6]"
            />
            Show Header Banner
          </label>
        </div>

        <form onSubmit={handleSaveBanner} className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { id: 'none', label: 'Hidden', Icon: MonitorPlay },
                { id: 'image', label: 'Photo Banner', Icon: ImageIcon },
                { id: 'video', label: 'Video Banner', Icon: Video },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setBannerType(id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                  bannerType === id
                    ? 'bg-[#8B5CF6] text-white'
                    : 'bg-white/[0.06] text-[#B6AFD4] hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}

            <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white cursor-pointer ml-auto">
              <Upload className="w-3.5 h-3.5 text-[#A78BFA]" />
              {uploadingBanner ? 'Uploading...' : 'Upload Banner Photo / Video'}
              <input
                type="file"
                accept="image/*,video/mp4,video/webm,video/quicktime"
                onChange={handleBannerUpload}
                disabled={uploadingBanner}
                className="hidden"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Banner Media URL
              </label>
              <input
                type="text"
                value={bannerUrl}
                onChange={(e) => setBannerUrl(e.target.value)}
                placeholder="/api/public/media/... or https://..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Optional Banner Caption
              </label>
              <input
                type="text"
                value={bannerCaption}
                onChange={(e) => setBannerCaption(e.target.value)}
                placeholder="Welcome to FADI KING MD..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>
          </div>

          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={savingBanner}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <ImageIcon className="w-4 h-4" />
              {savingBanner ? 'Saving...' : 'Save Header Banner'}
            </button>
          </div>

          {bannerFeedback && (
            <div className="text-xs text-[#E2DCF8] bg-white/[0.05] border border-white/[0.08] rounded-xl px-3.5 py-2.5">
              {bannerFeedback}
            </div>
          )}
        </form>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Live Screen Controller (Video, Picture, Message) */}
        <section className="lg:col-span-7 glass-surface rounded-2xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
            <div className="flex items-center gap-2.5">
              <MonitorPlay className="w-4 h-4 text-[#A78BFA]" />
              <div>
                <h2 className="text-lg font-semibold text-white">Public Live Screen Controller</h2>
                <p className="text-xs text-[#9E97C2]">
                  Publish a live picture, video, or announcement onto the public pairing screen.
                </p>
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-white cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="w-4 h-4 accent-[#8B5CF6]"
              />
              Show Live Screen Publicly
            </label>
          </div>

          <form onSubmit={handleSaveScreen} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Screen Headline
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="FADI KING MD Live Broadcast"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Live Message / Caption
              </label>
              <textarea
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Write live instructions or announcement for visitors..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="space-y-3">
              <label className="block text-xs font-medium text-[#C4BFE0]">
                Media Type (Picture / Video)
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { id: 'none', label: 'Text Only', Icon: MonitorPlay },
                    { id: 'image', label: 'Picture', Icon: ImageIcon },
                    { id: 'video', label: 'Video', Icon: Video },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMediaType(id)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                      mediaType === id
                        ? 'bg-[#8B5CF6] text-white'
                        : 'bg-white/[0.06] text-[#B6AFD4] hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}

                <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white cursor-pointer ml-auto">
                  <Upload className="w-3.5 h-3.5 text-[#A78BFA]" />
                  {uploading ? 'Uploading...' : 'Upload Picture / Video'}
                  <input
                    type="file"
                    accept="image/*,video/mp4,video/webm,video/quicktime"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {mediaType !== 'none' && (
              <div>
                <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                  Media URL (auto-filled after upload or paste direct link)
                </label>
                <input
                  type="text"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  placeholder="/api/public/media/... or https://..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-4 pt-2">
              {mediaType !== 'none' && mediaUrl ? (
                <span className="text-xs text-emerald-300 font-mono truncate max-w-xs">
                  Attached: {mediaUrl}
                </span>
              ) : (
                <span />
              )}
              <button
                type="submit"
                disabled={savingScreen}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <MonitorPlay className="w-4 h-4" />
                {savingScreen ? 'Publishing...' : 'Publish Live Screen'}
              </button>
            </div>

            {screenFeedback && (
              <div className="text-xs text-[#E2DCF8] bg-white/[0.05] border border-white/[0.08] rounded-xl px-3.5 py-2.5">
                {screenFeedback}
              </div>
            )}
          </form>
        </section>

        {/* Send Bell Notification Alert (Ghanti Alert Dispatcher) */}
        <section className="lg:col-span-5 glass-surface rounded-2xl p-6 space-y-5">
          <div className="flex items-center gap-2.5 pb-4 border-b border-white/[0.07]">
            <BellRing className="w-4 h-4 text-[#A78BFA]" />
            <div>
              <h2 className="text-lg font-semibold text-white">Send Bell Alert Notification</h2>
              <p className="text-xs text-[#9E97C2]">
                Rings the public alert bell and delivers your message to all active visitors.
              </p>
            </div>
          </div>

          <form onSubmit={handleSendAlert} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Alert Title
              </label>
              <input
                type="text"
                value={alertTitle}
                onChange={(e) => setAlertTitle(e.target.value)}
                placeholder="e.g. Server Maintenance / New VIP Slots"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Alert Priority
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['info', 'important', 'urgent'] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setAlertLevel(lvl)}
                    className={`py-2 rounded-xl text-xs font-medium capitalize transition-colors cursor-pointer ${
                      alertLevel === lvl
                        ? 'bg-[#8B5CF6] text-white'
                        : 'bg-white/[0.06] text-[#B6AFD4] hover:text-white'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Notification Message
              </label>
              <textarea
                rows={4}
                required
                value={alertMessage}
                onChange={(e) => setAlertMessage(e.target.value)}
                placeholder="Type the alert message you want visitors to hear & see..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <button
              type="submit"
              disabled={sendingAlert}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {sendingAlert ? 'Sending Alert...' : 'Send Bell Notification'}
            </button>

            {alertFeedback && (
              <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-3.5 py-2.5">
                {alertFeedback}
              </div>
            )}
          </form>
        </section>
      </div>

      {/* Dispatched Public Alerts History */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <h3 className="text-base font-semibold text-white">
            Active Public Bell Notifications ({alerts.length})
          </h3>
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={handleClearAlerts}
              className="text-xs text-rose-300 hover:text-rose-200 cursor-pointer"
            >
              Clear All
            </button>
          )}
        </div>

        <div className="divide-y divide-white/[0.06] mt-2">
          {alerts.length === 0 ? (
            <div className="py-8 text-center text-sm text-[#8B84AD]">
              No active notifications dispatched yet.
            </div>
          ) : (
            alerts.map((alert) => (
              <div key={alert.id} className="py-3.5 flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-white">{alert.title}</span>
                    <span aria-hidden="true" className="text-[#6F6891]">·</span>
                    <span
                      className={`text-xs capitalize ${
                        alert.level === 'urgent'
                          ? 'text-rose-400'
                          : alert.level === 'important'
                            ? 'text-amber-300'
                            : 'text-[#A78BFA]'
                      }`}
                    >
                      {alert.level}
                    </span>
                    <span aria-hidden="true" className="text-[#6F6891]">·</span>
                    <span className="text-xs font-mono tabular-nums text-[#7C759E]">
                      {alert.createdAt.slice(0, 19).replace('T', ' ')}
                    </span>
                  </div>
                  <p className="text-xs text-[#C4BFE0]">{alert.message}</p>
                </div>

                <button
                  type="button"
                  onClick={() => handleDeleteAlert(alert.id)}
                  className="text-xs text-rose-300 hover:text-rose-200 inline-flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
