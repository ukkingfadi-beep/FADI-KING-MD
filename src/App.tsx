import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Bell,
  BellOff,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Volume2,
  X,
} from 'lucide-react';
import { AdminLogsPanel } from './components/AdminLogsPanel';
import { BotControls } from './components/BotControls';
import { CommandCenter } from './components/CommandCenter';
import { LiveScreenAdmin } from './components/LiveScreenAdmin';
import { PublicPairingBoard } from './components/PublicPairingBoard';
import { SourceExplorer } from './components/SourceExplorer';
import { VipManager } from './components/VipManager';
import { WaveBackdrop } from './components/WaveBackdrop';
import type {
  BotStatusResponse,
  CommandItem,
  GroupConfig,
  PublicStateResponse,
  SourceFileEntry,
  VipUser,
} from './types/bot';

type AdminTabId = 'live' | 'vip' | 'commands' | 'controls' | 'logs' | 'source';

const ADMIN_NAV_ITEMS: Array<{ id: AdminTabId; label: string }> = [
  { id: 'live', label: 'Live & Alerts' },
  { id: 'vip', label: 'VIP Access' },
  { id: 'commands', label: 'Commands' },
  { id: 'controls', label: 'Control' },
  { id: 'logs', label: 'Logs & Health' },
  { id: 'source', label: 'Source' },
];

const TOKEN_STORAGE_KEY = 'fkmd_admin_token';
const SEEN_ALERTS_KEY = 'fkmd_seen_alerts';

function playBellChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const playTone = (freq: number, start: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration);
    };

    playTone(880, now, 0.35);
    playTone(1174.66, now + 0.14, 0.5);
  } catch {
    // Ignore autoplay restriction before user interaction
  }
}

export default function App() {
  const [adminToken, setAdminToken] = useState<string>(() => sessionStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const [isAdminView, setIsAdminView] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTabId>('live');
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [publicState, setPublicState] = useState<PublicStateResponse | null>(null);
  const [adminStatus, setAdminStatus] = useState<BotStatusResponse | null>(null);
  const [vips, setVips] = useState<VipUser[]>([]);
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [groups, setGroups] = useState<GroupConfig[]>([]);
  const [sourceFiles, setSourceFiles] = useState<SourceFileEntry[]>([]);

  const [alertsDrawerOpen, setAlertsDrawerOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [seenAlertIds, setSeenAlertIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(SEEN_ALERTS_KEY) || '[]') as string[];
    } catch {
      return [];
    }
  });
  const knownAlertIdsRef = useRef<Set<string> | null>(null);

  const fetchPublicState = useCallback(async () => {
    try {
      const res = await fetch('/api/public/state', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as PublicStateResponse;
      setPublicState(data);

      const incomingIds = data.alerts.map((a) => a.id);
      if (knownAlertIdsRef.current === null) {
        knownAlertIdsRef.current = new Set(incomingIds);
      } else {
        const hasBrandNew = incomingIds.some((id) => !knownAlertIdsRef.current!.has(id));
        if (hasBrandNew && soundEnabled) {
          playBellChime();
        }
        for (const id of incomingIds) knownAlertIdsRef.current.add(id);
      }
    } catch {
      // Transient poll error
    }
  }, [soundEnabled]);

  const fetchAdminData = useCallback(async () => {
    if (!adminToken) return;
    const headers = { Authorization: `Bearer ${adminToken}` };
    try {
      const [statusRes, vipsRes, cmdsRes, groupsRes] = await Promise.all([
        fetch('/api/bot/status', { headers, cache: 'no-store' }),
        fetch('/api/vips', { headers, cache: 'no-store' }),
        fetch('/api/commands', { headers, cache: 'no-store' }),
        fetch('/api/groups', { headers, cache: 'no-store' }),
      ]);

      if (statusRes.status === 401) {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        setAdminToken('');
        setIsAdminView(false);
        return;
      }

      if (statusRes.ok) setAdminStatus(await statusRes.json());
      if (vipsRes.ok) {
        const d = await vipsRes.json();
        setVips(d.vips || []);
      }
      if (cmdsRes.ok) {
        const d = await cmdsRes.json();
        setCommands(d.commands || []);
      }
      if (groupsRes.ok) {
        const d = await groupsRes.json();
        setGroups(d.groups || []);
      }
    } catch {
      // Ignore transient failure
    }
  }, [adminToken]);

  const refreshAll = useCallback(async () => {
    await fetchPublicState();
    if (adminToken && isAdminView) {
      await fetchAdminData();
    }
  }, [fetchPublicState, fetchAdminData, adminToken, isAdminView]);

  // Verify persisted session token on mount
  useEffect(() => {
    if (!adminToken) return;
    void fetch('/api/admin/session', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.authenticated) {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          setAdminToken('');
          setIsAdminView(false);
        }
      })
      .catch(() => {});
  }, [adminToken]);

  useEffect(() => {
    void refreshAll();
    const intervalMs = isAdminView ? 2000 : 3000;
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refreshAll();
      }
    }, intervalMs);
    const onVisibility = () => {
      if (!document.hidden) void refreshAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshAll, isAdminView]);

  useEffect(() => {
    if (isAdminView && adminToken && adminTab === 'source' && sourceFiles.length === 0) {
      void fetch('/api/source/files', {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.files) setSourceFiles(d.files);
        })
        .catch(() => {});
    }
  }, [isAdminView, adminToken, adminTab, sourceFiles.length]);

  const alerts = publicState?.alerts || [];
  const unreadAlerts = alerts.filter((a) => !seenAlertIds.includes(a.id)).length;

  function openAlertsDrawer() {
    setAlertsDrawerOpen(true);
    const allIds = alerts.map((a) => a.id);
    const merged = Array.from(new Set([...seenAlertIds, ...allIds]));
    setSeenAlertIds(merged);
    localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify(merged.slice(-100)));
  }

  function handleOpenAdminTrigger() {
    if (adminToken) {
      setIsAdminView(true);
      void fetchAdminData();
    } else {
      setLoginError(null);
      setPasswordInput('');
      setShowLoginModal(true);
    }
  }

  async function handleAdminLogin(e: FormEvent) {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.token) {
        setLoginError(data.error || 'Incorrect password.');
        return;
      }
      sessionStorage.setItem(TOKEN_STORAGE_KEY, data.token);
      setAdminToken(data.token);
      setShowLoginModal(false);
      setIsAdminView(true);
      setAdminTab('live');
    } catch {
      setLoginError('Unable to reach server.');
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleAdminLogout() {
    if (adminToken) {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
    }
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setAdminToken('');
    setIsAdminView(false);
    setAdminStatus(null);
    setSourceFiles([]);
  }

  return (
    <div className="min-h-screen bg-[#07050F] text-[#F5F3FF] relative">
      <WaveBackdrop />

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-white/[0.09] bg-[#0A0716]/85 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.45)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
          {/* Zone 1: FK Crest + Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => setIsAdminView(false)}
            className="inline-flex items-center gap-2.5 text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-[#7C3AED]/45 to-[#3B0764]/75 border border-[#C4B5FD]/45 shadow-[0_0_14px_rgba(139,92,246,0.4)] flex items-center justify-center shrink-0">
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4 text-[#EDE9FE]"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M12 2.5L20 7v10l-8 4.5L4 17V7l8-4.5z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
                <text
                  x="12"
                  y="15"
                  textAnchor="middle"
                  fill="currentColor"
                  fontSize="8"
                  fontWeight="700"
                  fontFamily="sans-serif"
                >
                  FK
                </text>
              </svg>
            </span>
            <span>FADI KING MD</span>
          </button>

          {/* Zone 2: Navigation Links (Public vs Admin) */}
          {!isAdminView ? (
            <nav className="hidden md:flex items-center gap-6">
              <a
                href="#top"
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                className="text-sm font-medium text-white border-b-2 border-[#8B5CF6] py-1 whitespace-nowrap shrink-0"
              >
                Pairing
              </a>
            </nav>
          ) : (
            <nav className="hidden md:flex items-center gap-5">
              {ADMIN_NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setAdminTab(item.id)}
                  className={`text-sm font-medium py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                    adminTab === item.id
                      ? 'text-white border-[#8B5CF6]'
                      : 'text-[#A9A2C8] border-transparent hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          )}

          {/* Zone 3: Primary Action(s) */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={openAlertsDrawer}
              aria-label="Open Alert Notifications"
              className="relative inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Bell className="w-4 h-4 text-[#C4B5FD]" />
              {unreadAlerts > 0 && (
                <span className="font-mono tabular-nums text-xs text-rose-300 font-semibold">
                  {unreadAlerts}
                </span>
              )}
            </button>

            {!isAdminView ? (
              <button
                type="button"
                onClick={handleOpenAdminTrigger}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-b from-[#6D28D9]/55 to-[#3B0764]/70 hover:from-[#7C3AED]/70 hover:to-[#4C1D95]/80 border border-[#C4B5FD]/40 shadow-[0_0_16px_rgba(139,92,246,0.28)] text-xs font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5 text-[#DDD6FE]" />
                <span>Admin Panel</span>
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAdminView(false)}
                  className="px-3.5 py-2 rounded-full bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Public Pairing
                </button>
                <button
                  type="button"
                  onClick={handleAdminLogout}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/25 text-xs font-semibold text-rose-200 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Lock</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Mobile Admin Sub-Nav Bar (inline under header so it never overlaps inputs) */}
        {isAdminView && adminToken && (
          <nav
            aria-label="Mobile Admin Navigation"
            className="md:hidden border-t border-white/[0.06] px-4 py-2 flex items-center gap-2 overflow-x-auto"
          >
            {ADMIN_NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setAdminTab(item.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  adminTab === item.id
                    ? 'bg-[#8B5CF6] text-white'
                    : 'bg-white/[0.04] text-[#B6AFD4] hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        )}
      </header>

      {/* Main Content Workspace */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-14">
        {!isAdminView || !adminToken ? (
          <PublicPairingBoard
            publicState={publicState}
            onRefresh={refreshAll}
          />
        ) : (
          <div className="space-y-6">
            {adminTab === 'live' && (
              <LiveScreenAdmin
                portalBanner={publicState?.portalBanner || null}
                liveScreen={publicState?.liveScreen || null}
                alerts={alerts}
                config={adminStatus?.config || null}
                adminToken={adminToken}
                onRefresh={refreshAll}
              />
            )}
            {adminTab === 'vip' && (
              <VipManager
                vips={vips}
                blockedKeys={adminStatus?.blockedKeys || []}
                adminToken={adminToken}
                onRefresh={refreshAll}
              />
            )}
            {adminTab === 'commands' && (
              <CommandCenter
                commands={commands}
                prefix={adminStatus?.config.prefix || '.'}
                adminToken={adminToken}
                onRefresh={refreshAll}
              />
            )}
            {adminTab === 'controls' && (
              <BotControls
                config={adminStatus?.config || null}
                groups={groups}
                adminToken={adminToken}
                onRefresh={refreshAll}
              />
            )}
            {adminTab === 'logs' && (
              <AdminLogsPanel
                status={adminStatus}
                adminToken={adminToken}
                onRefresh={refreshAll}
              />
            )}
            {adminTab === 'source' && (
              <SourceExplorer files={sourceFiles} adminToken={adminToken} />
            )}
          </div>
        )}
      </main>

      {/* Bell Alert Notification Drawer */}
      {alertsDrawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md h-full bg-[#0D091A] border-l border-white/[0.1] p-6 flex flex-col justify-between">
            <div className="space-y-4 overflow-hidden flex flex-col flex-1">
              <div className="flex items-center justify-between gap-3 pb-4 border-b border-white/[0.08]">
                <div className="flex items-center gap-2.5">
                  <Bell className="w-4 h-4 text-[#A78BFA]" />
                  <h2 className="text-base font-semibold text-white">
                    Admin Alert Notifications
                  </h2>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !soundEnabled;
                      setSoundEnabled(next);
                      if (next) playBellChime();
                    }}
                    aria-label={soundEnabled ? 'Mute alert bell' : 'Enable alert bell'}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[#D5D0ED] cursor-pointer"
                  >
                    {soundEnabled ? <Volume2 className="w-3.5 h-3.5 text-[#A78BFA]" /> : <BellOff className="w-3.5 h-3.5" />}
                    {soundEnabled ? 'Sound On' : 'Muted'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAlertsDrawerOpen(false)}
                    aria-label="Close notifications"
                    className="p-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-white/[0.06]">
                {alerts.length === 0 ? (
                  <div className="py-16 text-center text-sm text-[#8B84AD]">
                    No admin alerts right now. New messages from the admin will chime and appear here.
                  </div>
                ) : (
                  alerts.map((alert) => (
                    <div key={alert.id} className="py-4 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white">{alert.title}</span>
                        <span
                          className={`text-[11px] font-medium capitalize ${
                            alert.level === 'urgent'
                              ? 'text-rose-400'
                              : alert.level === 'important'
                                ? 'text-amber-300'
                                : 'text-[#A78BFA]'
                          }`}
                        >
                          {alert.level}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-[#D5D0ED]">
                        {alert.message}
                      </p>
                      <div className="text-[11px] font-mono tabular-nums text-[#7C759E]">
                        {alert.createdAt.slice(0, 19).replace('T', ' ')}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Password Login Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm glass-surface rounded-2xl p-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-[#A78BFA]" />
                <h2 className="text-base font-semibold text-white">Unlock Admin Panel</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowLoginModal(false)}
                className="p-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[#9E97C2]">
              Enter the administrator password to manage VIP access, live screen media, bell alerts, commands, and bot settings.
            </p>

            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                  Admin Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoFocus
                    required
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="Enter admin password"
                    className="w-full pl-3.5 pr-10 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.12] text-sm text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#9E97C2] hover:text-white cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {loginError && (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-3 py-2">
                  {loginError}
                </div>
              )}

              <button
                type="submit"
                disabled={loggingIn}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all cursor-pointer disabled:opacity-50"
              >
                {loggingIn ? 'Verifying...' : 'Unlock Admin Panel'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
