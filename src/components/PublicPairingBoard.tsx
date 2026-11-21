import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  EyeOff,
  Infinity as InfinityIcon,
  KeyRound,
  MessageCircle,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react';
import type { ConnectionStatus, PublicStateResponse } from '../types/bot';

interface PublicPairingBoardProps {
  publicState: PublicStateResponse | null;
  onRefresh: () => Promise<void>;
}

interface SecurityFeatureItem {
  id: 'antiban' | 'uptime' | 'stealth' | 'instant';
  label: string;
  detail: string;
}

const CORE_SECURITY_FEATURES: SecurityFeatureItem[] = [
  {
    id: 'antiban',
    label: 'Anti-Ban Shield',
    detail: 'Smart human-paced delays and cooldown pacing keep WhatsApp Multi-Device sessions safe.',
  },
  {
    id: 'uptime',
    label: '24/7 Cloud Uptime',
    detail: 'Persistent database storage and automatic socket recovery maintain uninterrupted uptime.',
  },
  {
    id: 'stealth',
    label: 'Stealth Privacy',
    detail: 'Private Mode and Single Tick Shield suppress read receipts and restrict commands to the Owner.',
  },
  {
    id: 'instant',
    label: 'Instant Pairing',
    detail: 'Generate an 8-digit pairing code or scan a live QR handshake in seconds.',
  },
];

function FeatureIcon({ id }: { id: SecurityFeatureItem['id'] }) {
  switch (id) {
    case 'antiban':
      return <ShieldCheck className="w-4 h-4 text-[#C4B5FD]" />;
    case 'uptime':
      return <InfinityIcon className="w-4 h-4 text-[#C4B5FD]" />;
    case 'stealth':
      return <EyeOff className="w-4 h-4 text-[#C4B5FD]" />;
    case 'instant':
      return <Zap className="w-4 h-4 text-[#C4B5FD]" />;
  }
}

export function PublicPairingBoard({
  publicState,
  onRefresh,
}: PublicPairingBoardProps) {
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [targetMode, setTargetMode] = useState<'vip' | 'main'>('vip');
  const [pairingMethod, setPairingMethod] = useState<'code' | 'qr'>('code');
  const [selectedFeature, setSelectedFeature] = useState<SecurityFeatureItem['id'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generatedPhone, setGeneratedPhone] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<ConnectionStatus>('idle');
  const [authReason, setAuthReason] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const bot = publicState?.bot;
  const banner = publicState?.portalBanner;
  const isVipGateActive = Boolean(bot?.vipOnlyPairing);

  useEffect(() => {
    if (!generatedPhone) return;
    let cancelled = false;
    let notifiedConnected = false;
    const pollStatus = async () => {
      try {
        const res = await fetch(
          `/api/bot/pair-status?phone=${encodeURIComponent(generatedPhone)}`,
          { cache: 'no-store' }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { status?: ConnectionStatus };
        if (!cancelled && data.status) {
          setPairStatus(data.status);
          if (data.status === 'connected' && !notifiedConnected) {
            notifiedConnected = true;
            void onRefresh();
          }
        }
      } catch {
        // Ignore transient status poll
      }
    };
    void pollStatus();
    const timer = setInterval(() => {
      if (!document.hidden) void pollStatus();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [generatedPhone, onRefresh]);

  async function handleGenerateCode(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setGeneratedCode(null);
    setAuthReason(null);
    setPairStatus('idle');

    try {
      const res = await fetch('/api/bot/pair-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim(),
          token: token.trim() || undefined,
          target: targetMode,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error || 'Pairing code generation failed.');
      } else if (data.pairingCode) {
        setGeneratedCode(data.pairingCode);
        setGeneratedPhone(data.phone);
        setPairStatus('pairing_ready');
        setAuthReason(data.reason || '8-Digit Pairing Code Ready');
      } else if (data.pending) {
        setAuthReason(data.message);
      }
      await onRefresh();
    } catch {
      setErrorMsg('Network error reaching the FADI KING MD server.');
    } finally {
      setLoading(false);
    }
  }

  async function handleStartQr() {
    setLoading(true);
    setErrorMsg(null);
    setPairingMethod('qr');
    try {
      const res = await fetch('/api/bot/start-qr', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) setErrorMsg(data.error || 'Could not start QR session.');
      await onRefresh();
    } catch {
      setErrorMsg('Failed to initialize QR pairing socket.');
    } finally {
      setLoading(false);
    }
  }

  async function copyCode(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const displayedCode = generatedCode || bot?.pairingCode || null;
  const displayedPhone = generatedPhone || null;
  const isPairedPhoneConnected = Boolean(displayedPhone && pairStatus === 'connected');
  const isCompletingHandshake = Boolean(displayedPhone && pairStatus === 'connecting');
  const activeFeatureObj = CORE_SECURITY_FEATURES.find((f) => f.id === selectedFeature) || null;

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Dynamic Top Header Media Banner (Uploaded/Configured via Admin Panel) */}
      {banner?.enabled && banner.mediaType !== 'none' && banner.mediaUrl && (
        <section className="fkmd-luminous-frame rounded-3xl overflow-hidden">
          {banner.mediaType === 'image' ? (
            <img
              src={banner.mediaUrl}
              alt={banner.caption || 'FADI KING MD Portal Banner'}
              referrerPolicy="no-referrer"
              className="w-full max-h-[300px] object-cover"
            />
          ) : (
            <video
              src={banner.mediaUrl}
              autoPlay
              muted
              loop
              playsInline
              controls
              className="w-full max-h-[320px] object-cover bg-black"
            />
          )}
          {banner.caption && (
            <div className="px-5 py-3 border-t border-white/[0.08] text-xs sm:text-sm text-[#E2DCF8] text-center">
              {banner.caption}
            </div>
          )}
        </section>
      )}

      {/* Centered Hero Header */}
      <section className="text-center space-y-3 pt-2">
        <div className="inline-flex items-center justify-center gap-2 text-xs sm:text-sm text-[#C4B5FD] font-medium">
          <Users className="w-4 h-4 text-[#A78BFA]" />
          <span>Active Paid Users</span>
          <span aria-hidden="true" className="text-white/35">·</span>
          <span className="font-mono tabular-nums font-bold text-white">
            {bot?.activePaidUsersCount ?? 0}
          </span>
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-[54px] font-extrabold tracking-tight leading-[1.08] bg-gradient-to-b from-white via-[#EDE9FE] to-[#A78BFA] bg-clip-text text-transparent [text-wrap:balance]">
          {bot?.botName || 'FADI KING MD'}
        </h1>

        <p className="text-sm sm:text-base leading-relaxed text-[#C4BFE0] max-w-md mx-auto">
          Link any WhatsApp Multi-Device number instantly via pairing code or QR.
        </p>
      </section>

      {/* Main Luminous Double-Compartment Pairing Frame */}
      <section className="fkmd-luminous-frame rounded-[26px] p-4 sm:p-6 space-y-5">
        {/* Top Compartment: Pairing Code & QR Gateway */}
        <div className="space-y-5 px-1 sm:px-2 pt-1">
          <div>
            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
              Pairing Code &amp; QR Gateway
            </h2>
            <p className="text-xs sm:text-sm text-[#B8B1D6] mt-1">
              {isVipGateActive
                ? 'VIP numbers & FKMD access tokens authorized for pairing'
                : 'Open pairing for everyone'}
            </p>
          </div>

          {/* Segmented Method Toggle (8-Digit Code | QR Code) */}
          <div className="grid grid-cols-2 p-1 rounded-full bg-[#090613]/85 border border-white/[0.12] shadow-inner">
            <button
              type="button"
              onClick={() => setPairingMethod('code')}
              className={`min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold rounded-full transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                pairingMethod === 'code'
                  ? 'bg-gradient-to-b from-white/20 to-white/[0.06] text-white border border-white/25 shadow-[0_2px_12px_rgba(139,92,246,0.28)]'
                  : 'text-[#A9A2C8] hover:text-white border border-transparent'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>8-Digit Code</span>
            </button>
            <button
              type="button"
              onClick={handleStartQr}
              className={`min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold rounded-full transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                pairingMethod === 'qr'
                  ? 'bg-gradient-to-b from-white/20 to-white/[0.06] text-white border border-white/25 shadow-[0_2px_12px_rgba(139,92,246,0.28)]'
                  : 'text-[#A9A2C8] hover:text-white border border-transparent'
              }`}
            >
              <QrCode className="w-3.5 h-3.5" />
              <span>QR Code</span>
            </button>
          </div>

          {pairingMethod === 'code' ? (
            <form onSubmit={handleGenerateCode} className="space-y-4">
              <div className={`grid grid-cols-1 ${isVipGateActive ? 'sm:grid-cols-2' : ''} gap-3.5`}>
                <div>
                  <label className="sr-only" htmlFor="fkmd-phone-input">
                    WhatsApp Number with country code
                  </label>
                  <div className="fkmd-specular-input rounded-full flex items-center px-4 sm:px-5 py-1 transition-all">
                    <input
                      id="fkmd-phone-input"
                      type="text"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+92 300 0000000"
                      required
                      className="w-full min-h-[44px] bg-transparent text-sm sm:text-base font-mono tabular-nums text-white placeholder:text-[#8E86B0] focus:outline-none"
                    />
                    <MessageCircle className="w-5 h-5 text-[#C4B5FD]/80 shrink-0 ml-2" aria-hidden="true" />
                  </div>
                </div>

                {isVipGateActive && (
                  <div>
                    <label className="sr-only" htmlFor="fkmd-token-input">
                      VIP Access Token
                    </label>
                    <div className="fkmd-specular-input rounded-full flex items-center px-4 sm:px-5 py-1 transition-all">
                      <input
                        id="fkmd-token-input"
                        type="text"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="FKMD-XXXX-XXXX (optional)"
                        className="w-full min-h-[44px] bg-transparent text-sm font-mono text-white placeholder:text-[#8E86B0] focus:outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="fkmd-cta-btn w-full min-h-[48px] px-6 py-3 rounded-full text-sm sm:text-base font-semibold text-white transition-all whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Connecting...' : 'Generate 8-Digit Code'}
              </button>

              {/* Multi-Device | Primary Bot Selector */}
              <div className="flex items-center justify-start gap-3 pt-1 text-xs sm:text-sm">
                <button
                  type="button"
                  onClick={() => setTargetMode('vip')}
                  className={`py-1 font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    targetMode === 'vip'
                      ? 'text-white font-semibold'
                      : 'text-[#8B84AD] hover:text-[#D5D0ED]'
                  }`}
                >
                  Multi-Device
                </button>
                <span aria-hidden="true" className="text-white/25">|</span>
                <button
                  type="button"
                  onClick={() => setTargetMode('main')}
                  className={`py-1 font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    targetMode === 'main'
                      ? 'text-white font-semibold'
                      : 'text-[#8B84AD] hover:text-[#D5D0ED]'
                  }`}
                >
                  Primary Bot
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col sm:flex-row items-center gap-6 py-2">
              <div className="w-48 h-48 rounded-2xl bg-white p-2.5 flex items-center justify-center shrink-0">
                {bot?.qrDataUrl ? (
                  <img
                    src={bot.qrDataUrl}
                    alt="FADI KING MD WhatsApp QR Code"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-center px-3 text-slate-600">
                    <QrCode className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                    <div className="text-xs font-medium">
                      {bot?.status === 'connecting' ? 'Generating QR...' : 'Click QR Code to initialize'}
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-2 text-sm text-[#B6AFD4]">
                <div className="font-semibold text-white">Scan with WhatsApp Linked Devices</div>
                <p className="text-xs leading-relaxed text-[#9E97C2]">
                  1. Open WhatsApp on your mobile phone and open Settings / Linked Devices.
                </p>
                <p className="text-xs leading-relaxed text-[#9E97C2]">
                  2. Tap Link a Device and scan the QR code shown here.
                </p>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="flex items-start gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/25 text-sm text-rose-200">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Pairing Notice</div>
                <div className="text-xs text-rose-200/80 mt-0.5">{errorMsg}</div>
              </div>
            </div>
          )}

          {isPairedPhoneConnected && displayedPhone ? (
            <div className="pt-4 border-t border-white/[0.1] flex items-center gap-3 text-emerald-300">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-white">
                  WhatsApp Connected Successfully
                </div>
                <div className="text-xs font-mono tabular-nums text-emerald-300 mt-0.5">
                  Session linked! Type {bot?.prefix || '.'}menu in WhatsApp.
                </div>
              </div>
            </div>
          ) : (
            displayedCode && (
              <div className="pt-4 border-t border-white/[0.1] flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs text-emerald-300">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>
                      {isCompletingHandshake
                        ? 'Code verified — completing WhatsApp login...'
                        : authReason || '8-Digit Pairing Code Ready'}
                    </span>
                  </div>
                  <div className="mt-1.5 text-3xl font-bold font-mono tracking-[0.18em] tabular-nums text-white">
                    {displayedCode}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => copyCode(displayedCode)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-white/[0.08] hover:bg-white/[0.15] border border-white/15 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy Code'}
                </button>
              </div>
            )
          )}
        </div>

        {/* Bottom Compartment: Core Features & Security */}
        <div className="fkmd-inner-panel rounded-[20px] p-4 sm:p-5 space-y-4">
          <h3 className="text-base sm:text-lg font-semibold text-white">
            Core Features &amp; Security
          </h3>

          <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
            {CORE_SECURITY_FEATURES.map((item) => {
              const isSelected = selectedFeature === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedFeature((prev) => (prev === item.id ? null : item.id))}
                  className={`min-h-[44px] flex items-center gap-2 sm:gap-3 px-2.5 sm:px-4 py-2 rounded-full text-left transition-all cursor-pointer border ${
                    isSelected
                      ? 'bg-[#8B5CF6]/20 border-[#A78BFA]/55 text-white shadow-[0_0_20px_rgba(139,92,246,0.22)]'
                      : 'bg-[#120D24]/85 border-white/[0.14] text-[#EDE9FE] hover:border-[#A78BFA]/45 hover:bg-[#191233]'
                  }`}
                >
                  <span className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-gradient-to-b from-[#8B5CF6]/35 to-[#6D28D9]/25 border border-[#C4B5FD]/30 flex items-center justify-center shrink-0">
                    <FeatureIcon id={item.id} />
                  </span>
                  <span className="text-[11px] sm:text-sm font-medium whitespace-nowrap truncate">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>

          {activeFeatureObj ? (
            <p className="text-xs sm:text-[13px] leading-relaxed text-[#D5D0ED] pt-0.5">
              {activeFeatureObj.detail}
            </p>
          ) : (
            <p className="text-xs sm:text-[13px] leading-relaxed text-[#A9A2C8] pt-0.5">
              Advanced security and performance protocols optimized for continuous operations.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
