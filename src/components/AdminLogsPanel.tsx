import { useState } from 'react';
import { RefreshCw, ShieldAlert, Trash2, Wifi, WifiOff } from 'lucide-react';
import type { BotStatusResponse } from '../types/bot';

interface AdminLogsPanelProps {
  status: BotStatusResponse | null;
  adminToken: string;
  onRefresh: () => Promise<void>;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export function AdminLogsPanel({ status, adminToken, onRefresh }: AdminLogsPanelProps) {
  const [busy, setBusy] = useState(false);
  const bot = status?.bot;
  const config = status?.config;
  const stats = status?.stats;

  async function handleRestart() {
    setBusy(true);
    try {
      await fetch('/api/bot/restart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleClearSession() {
    setBusy(true);
    try {
      await fetch('/api/bot/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ clearSession: true }),
      });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Admin Telemetry & Socket Controls */}
      <section className="glass-surface rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            {bot?.status === 'connected' ? (
              <Wifi className="w-4 h-4 text-emerald-400" />
            ) : (
              <WifiOff className="w-4 h-4 text-[#A78BFA]" />
            )}
            <div>
              <h2 className="text-lg font-semibold text-white">Bot Health & Session Lifecycle</h2>
              <p className="text-xs text-[#9E97C2]">
                Status: {bot?.status || 'idle'} · Prefix {config?.prefix || '.'} · Mode {config?.mode || 'public'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleRestart}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-white cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#A78BFA]" />
              Restart Socket
            </button>
            <button
              type="button"
              onClick={handleClearSession}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Reset Main Session
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-[#948DB8]">Active VIPs</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-white">
              {stats?.activeVips ?? 0}
            </div>
          </div>
          <div>
            <div className="text-xs text-[#948DB8]">Total Pairings</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-white">
              {stats?.totalPairings ?? 0}
            </div>
          </div>
          <div>
            <div className="text-xs text-[#948DB8]">Rate-Limit Blocks</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-white">
              {stats?.activeBlocks ?? 0}
            </div>
          </div>
          <div>
            <div className="text-xs text-[#948DB8]">Uptime</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-white">
              {bot ? formatDuration(bot.uptimeSeconds) : '0h 0m 0s'}
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-white/[0.07] flex items-start gap-2.5 text-xs text-[#A9A2C8]">
          <ShieldAlert className="w-4 h-4 text-[#A78BFA] shrink-0 mt-0.5" />
          <div className="font-mono tabular-nums">
            Anti-Ban Guardrails: Pair CD {config?.pairCooldownSeconds ?? 60}s · Cmd CD {config?.cmdCooldownSeconds ?? 3}s / Grp {config?.groupCmdCooldownSeconds ?? 2}s · Tag {config?.tagCooldownSeconds ?? 120}s ({config?.tagMaxPerHour ?? 6}/hr) · Broadcast {config?.broadcastDelayMinMs ?? 2500}–{config?.broadcastDelayMaxMs ?? 5500}ms (cap {config?.maxBroadcastTargets ?? 25}) · Reconnect Cap {config?.maxReconnectAttempts ?? 8}
          </div>
        </div>
      </section>

      {/* Pairing Audit & Live Event Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="glass-surface rounded-2xl p-6">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
            <h3 className="text-base font-semibold text-white">VIP Pairing Security Audit</h3>
            <span className="text-xs text-[#9E97C2] font-mono tabular-nums">
              {status?.pairingLogs.length ?? 0} events
            </span>
          </div>

          <div className="divide-y divide-white/[0.06] mt-2 max-h-80 overflow-y-auto">
            {(!status?.pairingLogs || status.pairingLogs.length === 0) ? (
              <div className="py-10 text-center text-sm text-[#8B84AD]">
                No pairing requests recorded yet.
              </div>
            ) : (
              status.pairingLogs.map((item) => (
                <div key={item.id} className="py-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-mono tabular-nums text-white">
                      <span>+{item.number}</span>
                      <span aria-hidden="true" className="text-[#6F6891]">·</span>
                      <span
                        className={
                          item.status === 'authorized'
                            ? 'text-emerald-400 text-xs font-sans font-medium'
                            : item.status === 'rate_limited'
                              ? 'text-amber-400 text-xs font-sans font-medium'
                              : 'text-rose-400 text-xs font-sans font-medium'
                        }
                      >
                        {item.status === 'authorized'
                          ? 'Authorized'
                          : item.status === 'rate_limited'
                            ? 'Rate Limited'
                            : item.status === 'denied'
                              ? 'Denied'
                              : 'Socket Error'}
                      </span>
                    </div>
                    <p className="text-xs text-[#9E97C2] truncate mt-0.5">{item.reason}</p>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-[#7C759E] shrink-0">
                    {item.timestamp.slice(11, 19)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="glass-surface rounded-2xl p-6">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
            <h3 className="text-base font-semibold text-white">Live Bot & Guardrail Logs</h3>
            <span className="text-xs text-[#9E97C2] font-mono tabular-nums">
              {bot?.persistedSessions.length ?? 0} saved sessions
            </span>
          </div>

          <div className="divide-y divide-white/[0.06] mt-2 max-h-80 overflow-y-auto font-mono text-xs">
            {(!status?.logs || status.logs.length === 0) ? (
              <div className="py-10 text-center font-sans text-sm text-[#8B84AD]">
                Waiting for runtime events.
              </div>
            ) : (
              status.logs.map((entry) => (
                <div key={entry.id} className="py-2.5 flex items-start gap-3">
                  <span className="text-[#6F6891] tabular-nums shrink-0">
                    {entry.timestamp.slice(11, 19)}
                  </span>
                  <span
                    className={`shrink-0 uppercase ${
                      entry.level === 'error'
                        ? 'text-rose-400'
                        : entry.level === 'security' || entry.level === 'warn'
                          ? 'text-amber-400'
                          : entry.level === 'cmd'
                            ? 'text-[#A78BFA]'
                            : 'text-emerald-400'
                    }`}
                  >
                    {entry.module}
                  </span>
                  <span className="text-[#D5D0ED] break-words">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
