import { useState, type FormEvent } from 'react';
import {
  Bell,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  MonitorPlay,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { PublicStateResponse } from '../types/bot';

interface PublicPairingBoardProps {
  publicState: PublicStateResponse | null;
  unreadAlerts: number;
  onOpenAlerts: () => void;
  onRefresh: () => Promise<void>;
}

export function PublicPairingBoard({
  publicState,
  unreadAlerts,
  onOpenAlerts,
  onRefresh,
}: PublicPairingBoardProps) {
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [targetMode, setTargetMode] = useState<'vip' | 'main'>('vip');
  const [pairingMethod, setPairingMethod] = useState<'code' | 'qr'>('code');
  const [loading, setLoading] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generatedPhone, setGeneratedPhone] = useState<string | null>(null);
  const [authReason, setAuthReason] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const bot = publicState?.bot;
  const live = publicState?.liveScreen;
  const isVipGateActive = Boolean(bot?.vipOnlyPairing);

  async function handleGenerateCode(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setGeneratedCode(null);
    setAuthReason(null);

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
  const displayedPhone = generatedPhone || bot?.pairingPhone || null;

  const activeMatchedSession = displayedPhone
    ? bot?.activeSessions?.find((s) => s.phone === displayedPhone)
    : undefined;
  const isPairedPhoneConnected = Boolean(
    (displayedPhone && activeMatchedSession?.status === 'connected') ||
      (displayedPhone && bot?.connectedPhone === displayedPhone && bot?.status === 'connected')
  );
  const isCompletingHandshake = Boolean(
    displayedPhone && activeMatchedSession?.status === 'connecting'
  );

  return (
    <div className="space-y-8">
      {/* Hero Split: Public Multi-Device Pairing Gateway */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Overview */}
        <div className="lg:col-span-5 flex flex-col justify-between gap-6 py-2">
          <div className="space-y-5">
            <div className="flex items-center gap-2 text-xs text-[#B6AFD4]">
              {bot?.status === 'connected' || isPairedPhoneConnected ? (
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-[#A78BFA]" />
              )}
              <span>
                {isPairedPhoneConnected || bot?.status === 'connected'
                  ? 'WhatsApp Connected'
                  : isCompletingHandshake
                    ? 'Completing Login Handshake...'
                    : bot?.status === 'qr_ready'
                      ? 'QR Ready for Scan'
                      : bot?.status === 'pairing_ready' || displayedCode
                        ? '8-Digit Code Issued'
                        : bot?.status === 'connecting'
                          ? 'Connecting Socket'
                          : bot?.status === 'logged_out'
                            ? 'Session Unlinked'
                            : 'Fast Pairing Ready'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {isVipGateActive ? 'VIP Protected' : 'Open Access'}
              </span>
            </div>

            <h1 className="text-3xl sm:text-4xl lg:text-[42px] font-semibold leading-[1.12] tracking-tight text-white [text-wrap:balance]">
              FADI KING MD Pairing Portal
            </h1>

            <p className="text-[15px] leading-relaxed text-[#A9A2C8] max-w-lg">
              Link any WhatsApp Multi-Device number instantly using an 8-digit pairing code or QR handshake.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 pt-6 border-t border-white/[0.08]">
            <div>
              <div className="text-xs text-[#948DB8]">Cooldown</div>
              <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-white">
                {bot?.pairCooldownSeconds ?? 10}s
              </div>
            </div>
            <div>
              <div className="text-xs text-[#948DB8]">Rate Window</div>
              <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-white">
                {bot?.maxPairAttempts ?? 6}/{bot?.pairWindowMinutes ?? 10}m
              </div>
            </div>
            <div>
              <div className="text-xs text-[#948DB8]">Alerts</div>
              <button
                type="button"
                onClick={onOpenAlerts}
                className="mt-1 inline-flex items-center gap-1.5 text-lg font-semibold font-mono tabular-nums text-[#C4B5FD] hover:text-white cursor-pointer"
              >
                <Bell className="w-4 h-4" />
                {unreadAlerts > 0 ? `${unreadAlerts} new` : `${publicState?.alerts.length ?? 0}`}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Multi-Device Pairing Studio */}
        <div className="lg:col-span-7 glass-surface rounded-2xl p-6 sm:p-7 flex flex-col justify-between gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">
                Pairing Code & QR Gateway
              </h2>
              <p className="text-xs text-[#9E97C2] mt-0.5">
                {isVipGateActive
                  ? `VIP numbers & FKMD tokens only · ${bot?.pairCooldownSeconds ?? 10}s cooldown`
                  : `Open pairing for everyone · ${bot?.pairCooldownSeconds ?? 10}s cooldown`}
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.07]">
              <button
                type="button"
                onClick={() => setPairingMethod('code')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  pairingMethod === 'code'
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#A9A2C8] hover:text-white'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                8-Digit Code
              </button>
              <button
                type="button"
                onClick={handleStartQr}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  pairingMethod === 'qr'
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#A9A2C8] hover:text-white'
                }`}
              >
                <QrCode className="w-3.5 h-3.5" />
                QR Code
              </button>
            </div>
          </div>

          {pairingMethod === 'code' ? (
            <form onSubmit={handleGenerateCode} className="space-y-4">
              <div className={`grid grid-cols-1 ${isVipGateActive ? 'sm:grid-cols-2' : ''} gap-4`}>
                <div>
                  <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                    WhatsApp Number (with country code)
                  </label>
                  <div className="relative">
                    <Smartphone className="w-4 h-4 text-[#8B84AD] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="923XXXXXXXXX"
                      required
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                    />
                  </div>
                </div>

                {isVipGateActive && (
                  <div>
                    <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                      VIP Access Token (optional if whitelisted)
                    </label>
                    <input
                      type="text"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="FKMD-XXXX-XXXX"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => setTargetMode('vip')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      targetMode === 'vip'
                        ? 'bg-white/[0.12] text-white'
                        : 'text-[#948DB8] hover:text-white'
                    }`}
                  >
                    Multi-Device
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetMode('main')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      targetMode === 'main'
                        ? 'bg-white/[0.12] text-white'
                        : 'text-[#948DB8] hover:text-white'
                    }`}
                  >
                    Primary Bot
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <KeyRound className="w-4 h-4" />
                  {loading ? 'Connecting...' : 'Generate 8-Digit Code'}
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
                ) : bot?.status === 'connected' ? (
                  <div className="text-center px-3 text-slate-900">
                    <ShieldCheck className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
                    <div className="text-xs font-semibold">Session Linked</div>
                    {bot.connectedPhone && (
                      <div className="text-[11px] font-mono mt-1">+{bot.connectedPhone}</div>
                    )}
                  </div>
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
            <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-500/10 border border-rose-500/25 text-sm text-rose-200">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Pairing Notice</div>
                <div className="text-xs text-rose-200/80 mt-0.5">{errorMsg}</div>
              </div>
            </div>
          )}

          {isPairedPhoneConnected && displayedPhone ? (
            <div className="pt-4 border-t border-white/[0.08] flex items-center gap-3 text-emerald-300">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-white">
                  WhatsApp Connected Successfully
                </div>
                <div className="text-xs font-mono tabular-nums text-emerald-300 mt-0.5">
                  +{displayedPhone} is now active. Type {bot?.prefix || '.'}menu in WhatsApp.
                </div>
              </div>
            </div>
          ) : (
            displayedCode && (
              <div className="pt-4 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs text-emerald-300">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>
                      {isCompletingHandshake
                        ? 'Code verified — completing WhatsApp login...'
                        : authReason || '8-Digit Pairing Code Ready'}
                    </span>
                    {displayedPhone && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">+{displayedPhone}</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1.5 text-3xl font-bold font-mono tracking-[0.18em] tabular-nums text-white">
                    {displayedCode}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => copyCode(displayedCode)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy Code'}
                </button>
              </div>
            )
          )}
        </div>
      </div>

      {/* Live Screen Section (Controlled from Admin Panel — Video / Picture / Message + Bell Alert Button) */}
      {live?.active && (
        <section id="live-screen" className="glass-surface rounded-2xl p-6 sm:p-7 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
            <div className="flex items-center gap-3">
              <MonitorPlay className="w-5 h-5 text-[#A78BFA]" />
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {live.title || 'Live Screen'}
                </h2>
                <div className="text-xs text-[#9E97C2] font-mono tabular-nums">
                  Updated {live.updatedAt.slice(0, 19).replace('T', ' ')}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenAlerts}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.07] hover:bg-[#8B5CF6] text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Alert Notifications</span>
              {unreadAlerts > 0 && (
                <span className="font-mono tabular-nums text-[#E9D5FF]">
                  ({unreadAlerts})
                </span>
              )}
            </button>
          </div>

          {live.message && (
            <p className="text-sm sm:text-[15px] leading-relaxed text-[#E2DCF8] whitespace-pre-line">
              {live.message}
            </p>
          )}

          {live.mediaType === 'image' && live.mediaUrl && (
            <div className="rounded-xl overflow-hidden border border-white/[0.08] bg-[#090612] max-h-[520px] flex items-center justify-center">
              <img
                src={live.mediaUrl}
                alt={live.title || 'Live Screen Broadcast'}
                referrerPolicy="no-referrer"
                className="w-full max-h-[520px] object-contain"
              />
            </div>
          )}

          {live.mediaType === 'video' && live.mediaUrl && (
            <div className="rounded-xl overflow-hidden border border-white/[0.08] bg-black">
              <video
                src={live.mediaUrl}
                controls
                playsInline
                autoPlay
                muted
                loop
                className="w-full max-h-[520px] mx-auto"
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
