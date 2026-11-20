import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PhoneOff, Plus, Radio, Save, Send, Shield, Trash2 } from 'lucide-react';
import type { BlockedCallerEntry, BotConfigView, GroupConfig } from '../types/bot';

interface BotControlsProps {
  config: BotConfigView | null;
  groups: GroupConfig[];
  adminToken: string;
  onRefresh: () => Promise<void>;
}

export function BotControls({ config, groups, adminToken, onRefresh }: BotControlsProps) {
  const [form, setForm] = useState<BotConfigView>({
    botName: 'FADI KING MD',
    ownerNumber: '923169760375',
    ownerName: 'FADI KING',
    prefix: '.',
    mode: 'public',
    vipOnlyPairing: false,
    maxPairAttempts: 6,
    pairWindowMinutes: 10,
    pairCooldownSeconds: 10,
    cmdCooldownSeconds: 1,
    groupCmdCooldownSeconds: 1,
    tagCooldownSeconds: 120,
    tagMaxPerHour: 6,
    autoReadMessages: false,
    autoStatusSeen: false,
    autoTyping: false,
    autoRecording: false,
    broadcastDelayMs: 2500,
    broadcastDelayMinMs: 2500,
    broadcastDelayMaxMs: 5500,
    maxBroadcastTargets: 25,
    maxReconnectAttempts: 8,
    humanDelayEnabled: false,
    humanDelayMinMs: 150,
    humanDelayMaxMs: 350,
    autoJoinGroupInvite: 'https://chat.whatsapp.com/JzcSJ0NCN1d9Ixnq7Bn9EH',
    autoJoinChannelInvite: '',
    sendConnectSelfMessage: true,
    anticallGlobal: false,
    antiScamGlobal: false,
    antiScamBlockAllStickers: false,
    stickerPack: 'FADI KING MD',
    stickerAuthor: 'VIP BOT',
  });
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastFeedback, setBroadcastFeedback] = useState<string | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);

  const [newGroupId, setNewGroupId] = useState('');

  const [blockedCallers, setBlockedCallers] = useState<BlockedCallerEntry[]>([]);
  const [anticallPhone, setAnticallPhone] = useState('');
  const [anticallError, setAnticallError] = useState<string | null>(null);

  const fetchAnticall = useCallback(async () => {
    try {
      const res = await fetch('/api/anticall', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && Array.isArray(data.blocked)) {
        setBlockedCallers(data.blocked);
      }
    } catch {
      // Ignore network hiccup
    }
  }, [adminToken]);

  useEffect(() => {
    if (config) {
      setForm(config);
    }
  }, [config]);

  useEffect(() => {
    void fetchAnticall();
  }, [fetchAnticall]);

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveFeedback(null);
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveFeedback('Configuration saved to persistent database (survives restarts & redeploys).');
        await onRefresh();
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleSendBroadcast(e: FormEvent) {
    e.preventDefault();
    if (!broadcastText.trim()) return;
    setBroadcasting(true);
    setBroadcastFeedback(null);
    try {
      const res = await fetch('/api/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ text: broadcastText.trim() }),
      });
      const data = await res.json();
      setBroadcastFeedback(data.message || 'Broadcast processed.');
    } finally {
      setBroadcasting(false);
    }
  }

  async function setGroupAntilinkMode(
    groupId: string,
    mode: 'off' | 'delete' | 'warn' | 'kick'
  ) {
    await fetch(`/api/groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ antilinkMode: mode, antilink: mode !== 'off' }),
    });
    await onRefresh();
  }

  async function toggleGroupSetting(
    groupId: string,
    field: 'welcome' | 'goodbye' | 'antiScam',
    value: boolean
  ) {
    await fetch(`/api/groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ [field]: value }),
    });
    await onRefresh();
  }

  async function handleAddGroupRule(e: FormEvent) {
    e.preventDefault();
    const trimmed = newGroupId.trim();
    if (!trimmed) return;
    const normalized = trimmed.endsWith('@g.us') ? trimmed : `${trimmed}@g.us`;
    await fetch(`/api/groups/${encodeURIComponent(normalized)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        antilink: true,
        antilinkMode: 'warn',
        antiScam: true,
        welcome: true,
        goodbye: false,
      }),
    });
    setNewGroupId('');
    await onRefresh();
  }

  async function handleAddAnticall(e: FormEvent) {
    e.preventDefault();
    setAnticallError(null);
    if (!anticallPhone.trim()) return;
    const res = await fetch('/api/anticall', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ phone: anticallPhone.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setAnticallError(data.error || 'Failed to add caller.');
      return;
    }
    setAnticallPhone('');
    await fetchAnticall();
  }

  async function handleRemoveAnticall(target: string) {
    await fetch(`/api/anticall/${encodeURIComponent(target)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await fetchAnticall();
  }

  return (
    <div className="space-y-8">
      {/* Core Bot & Security Settings */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.07]">
          <div>
            <h2 className="text-lg font-semibold text-white">Runtime & VIP Gate Configuration</h2>
            <p className="text-xs text-[#9E97C2] mt-0.5">
              Changes apply immediately to incoming WhatsApp messages and pairing requests.
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveConfig} className="mt-5 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Bot Name</label>
              <input
                type="text"
                value={form.botName}
                onChange={(e) => setForm({ ...form, botName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Owner Name</label>
              <input
                type="text"
                value={form.ownerName}
                onChange={(e) => setForm({ ...form, ownerName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Owner Number</label>
              <input
                type="text"
                value={form.ownerNumber}
                onChange={(e) => setForm({ ...form, ownerNumber: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Command Prefix</label>
              <input
                type="text"
                maxLength={3}
                value={form.prefix}
                onChange={(e) => setForm({ ...form, prefix: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Bot Access Mode</label>
              <select
                value={form.mode}
                onChange={(e) => setForm({ ...form, mode: e.target.value as 'public' | 'self' })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              >
                <option value="public">Public (Everyone)</option>
                <option value="self">Self / VIP Only</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Broadcast Min Delay (ms)
              </label>
              <input
                type="number"
                min={1000}
                max={20000}
                step={250}
                value={form.broadcastDelayMinMs}
                onChange={(e) => setForm({ ...form, broadcastDelayMinMs: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Broadcast Max Delay (ms)
              </label>
              <input
                type="number"
                min={1500}
                max={30000}
                step={250}
                value={form.broadcastDelayMaxMs}
                onChange={(e) => setForm({ ...form, broadcastDelayMaxMs: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Max Broadcast Targets / Batch
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={form.maxBroadcastTargets}
                onChange={(e) => setForm({ ...form, maxBroadcastTargets: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Pairing Cooldown (Seconds)
              </label>
              <input
                type="number"
                min={5}
                max={600}
                value={form.pairCooldownSeconds}
                onChange={(e) => setForm({ ...form, pairCooldownSeconds: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Max Pair Attempts / Window
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxPairAttempts}
                onChange={(e) => setForm({ ...form, maxPairAttempts: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Rate-Limit Window (Minutes)
              </label>
              <input
                type="number"
                min={1}
                max={120}
                value={form.pairWindowMinutes}
                onChange={(e) => setForm({ ...form, pairWindowMinutes: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                User Command Cooldown (Seconds)
              </label>
              <input
                type="number"
                min={0}
                max={60}
                value={form.cmdCooldownSeconds}
                onChange={(e) => setForm({ ...form, cmdCooldownSeconds: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Group Command Cooldown (Seconds)
              </label>
              <input
                type="number"
                min={0}
                max={60}
                value={form.groupCmdCooldownSeconds}
                onChange={(e) => setForm({ ...form, groupCmdCooldownSeconds: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Tagall / Hidetag Cooldown (Seconds)
              </label>
              <input
                type="number"
                min={15}
                max={1800}
                value={form.tagCooldownSeconds}
                onChange={(e) => setForm({ ...form, tagCooldownSeconds: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Max Tagall / Hour per Group
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={form.tagMaxPerHour}
                onChange={(e) => setForm({ ...form, tagMaxPerHour: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Max Auto-Reconnect Retries
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxReconnectAttempts}
                onChange={(e) => setForm({ ...form, maxReconnectAttempts: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Sticker Pack Name</label>
              <input
                type="text"
                value={form.stickerPack}
                onChange={(e) => setForm({ ...form, stickerPack: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Human Typing Delay Min (ms)
              </label>
              <input
                type="number"
                min={0}
                max={5000}
                step={100}
                value={form.humanDelayMinMs}
                onChange={(e) => setForm({ ...form, humanDelayMinMs: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                Human Typing Delay Max (ms)
              </label>
              <input
                type="number"
                min={0}
                max={8000}
                step={100}
                value={form.humanDelayMaxMs}
                onChange={(e) => setForm({ ...form, humanDelayMaxMs: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-white/[0.06]">
              <div>
                <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                  Auto-Join WhatsApp Group Link (On Pairing)
                </label>
                <input
                  type="text"
                  value={form.autoJoinGroupInvite}
                  onChange={(e) => setForm({ ...form, autoJoinGroupInvite: e.target.value })}
                  placeholder="https://chat.whatsapp.com/..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                />
                <p className="text-[11px] text-[#8B84AD] mt-1">
                  Joins automatically whenever any user pairs a bot (supports multiple comma-separated links).
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
                  Auto-Follow WhatsApp Channel Link (On Pairing)
                </label>
                <input
                  type="text"
                  value={form.autoJoinChannelInvite}
                  onChange={(e) => setForm({ ...form, autoJoinChannelInvite: e.target.value })}
                  placeholder="https://whatsapp.com/channel/..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                />
                <p className="text-[11px] text-[#8B84AD] mt-1">
                  Follows this WhatsApp Channel (or @newsletter JID) automatically when anyone pairs.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-white/[0.07]">
            <div className="flex flex-wrap items-center gap-6">
              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.humanDelayEnabled}
                  onChange={(e) => setForm({ ...form, humanDelayEnabled: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Human-Like Anti-Ban Delay
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.sendConnectSelfMessage}
                  onChange={(e) => setForm({ ...form, sendConnectSelfMessage: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Self-DM Connect Message
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.anticallGlobal}
                  onChange={(e) => setForm({ ...form, anticallGlobal: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Global Anti-Call Reject
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.vipOnlyPairing}
                  onChange={(e) => setForm({ ...form, vipOnlyPairing: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Enforce VIP-Only Pairing Gate
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoReadMessages}
                  onChange={(e) => setForm({ ...form, autoReadMessages: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-Read Incoming Chats
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoStatusSeen}
                  onChange={(e) => setForm({ ...form, autoStatusSeen: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-View WhatsApp Statuses
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoTyping}
                  onChange={(e) => setForm({ ...form, autoTyping: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-Typing Presence
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoRecording}
                  onChange={(e) => setForm({ ...form, autoRecording: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-Recording Presence
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.antiScamGlobal}
                  onChange={(e) => setForm({ ...form, antiScamGlobal: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Global Anti-Scam Shield (Stickers, Gaaliyan & Spam)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.antiScamBlockAllStickers}
                  onChange={(e) => setForm({ ...form, antiScamBlockAllStickers: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Strict Mode: Delete Non-Admin Stickers
              </label>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>

          {saveFeedback && (
            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-3.5 py-2.5">
              {saveFeedback}
            </div>
          )}
        </form>
      </section>

      {/* Lower Split: Group Moderation & Safe Broadcast */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="glass-surface rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 pb-4 border-b border-white/[0.07]">
            <Shield className="w-4 h-4 text-[#A78BFA]" />
            <h3 className="text-base font-semibold text-white">Group Moderation Rules</h3>
          </div>

          <form onSubmit={handleAddGroupRule} className="flex gap-2">
            <input
              type="text"
              value={newGroupId}
              onChange={(e) => setNewGroupId(e.target.value)}
              placeholder="Group JID (e.g. 1203630421@g.us)"
              className="flex-1 px-3.5 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              Add Group
            </button>
          </form>

          <div className="divide-y divide-white/[0.06]">
            {groups.length === 0 ? (
              <div className="py-8 text-center text-xs text-[#8B84AD]">
                No custom group overrides yet. Use <span className="font-mono text-white">.antilink on</span> or <span className="font-mono text-white">.welcome on</span> in any group or add a Group JID above.
              </div>
            ) : (
              groups.map((g) => {
                const mode = g.antilinkMode || (g.antilink ? 'delete' : 'off');
                return (
                  <div key={g.groupId} className="py-3.5 flex flex-wrap items-center justify-between gap-3">
                    <span className="font-mono text-xs text-white truncate max-w-[200px]">
                      {g.groupId}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={mode}
                        onChange={(e) =>
                          setGroupAntilinkMode(
                            g.groupId,
                            e.target.value as 'off' | 'delete' | 'warn' | 'kick'
                          )
                        }
                        aria-label={`Antilink mode for ${g.groupId}`}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border border-white/[0.1] focus:outline-none cursor-pointer ${
                          mode !== 'off'
                            ? 'bg-[#8B5CF6] text-white'
                            : 'bg-[#0A0714] text-[#9E97C2]'
                        }`}
                      >
                        <option value="off">Antilink: Off</option>
                        <option value="delete">Antilink: Delete Only</option>
                        <option value="warn">Antilink: 3-Warn Auto-Kick</option>
                        <option value="kick">Antilink: Instant Kick</option>
                      </select>

                      <button
                        type="button"
                        onClick={() =>
                          toggleGroupSetting(
                            g.groupId,
                            'antiScam',
                            !(g.antiScam ?? form.antiScamGlobal)
                          )
                        }
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                          (g.antiScam ?? form.antiScamGlobal)
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white/[0.06] text-[#9E97C2]'
                        }`}
                      >
                        Anti-Scam: {(g.antiScam ?? form.antiScamGlobal) ? 'On' : 'Off'}
                      </button>

                      {(['welcome', 'goodbye'] as const).map((field) => (
                        <button
                          key={field}
                          type="button"
                          onClick={() => toggleGroupSetting(g.groupId, field, !g[field])}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium capitalize transition-colors cursor-pointer ${
                            g[field]
                              ? 'bg-[#8B5CF6] text-white'
                              : 'bg-white/[0.06] text-[#9E97C2]'
                          }`}
                        >
                          {field}: {g[field] ? 'On' : 'Off'}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="glass-surface rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-white/[0.07]">
            <div className="flex items-center gap-2.5">
              <Radio className="w-4 h-4 text-[#A78BFA]" />
              <h3 className="text-base font-semibold text-white">Safe Group Broadcast</h3>
            </div>
            <span className="text-xs font-mono tabular-nums text-[#9E97C2]">
              {form.broadcastDelayMinMs}–{form.broadcastDelayMaxMs}ms · cap {form.maxBroadcastTargets}
            </span>
          </div>

          <form onSubmit={handleSendBroadcast} className="space-y-4">
            <textarea
              rows={4}
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              placeholder="Write your announcement to dispatch across all joined groups..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />

            <button
              type="submit"
              disabled={broadcasting}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {broadcasting ? 'Dispatching...' : 'Send Broadcast'}
            </button>

            {broadcastFeedback && (
              <div className="text-xs text-[#D5D0ED] bg-white/[0.05] border border-white/[0.08] rounded-xl px-3.5 py-2.5">
                {broadcastFeedback}
              </div>
            )}
          </form>
        </section>
      </div>

      {/* Anti-Call Guard Registry (Per-DM & Global) */}
      <section className="glass-surface rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <PhoneOff className="w-4 h-4 text-[#A78BFA]" />
            <div>
              <h3 className="text-base font-semibold text-white">Anti-Call Guard Registry</h3>
              <p className="text-xs text-[#9E97C2]">
                Global mode rejects all callers; per-chat rules can also be toggled in any DM with <span className="font-mono text-white">.anticall on</span> / <span className="font-mono text-white">off</span>.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono tabular-nums text-[#C4BFE0]">
            Global: {form.anticallGlobal ? 'ON' : 'OFF'} · Per-DM Blocked: {blockedCallers.length}
          </span>
        </div>

        <form onSubmit={handleAddAnticall} className="flex flex-wrap gap-2">
          <input
            type="text"
            value={anticallPhone}
            onChange={(e) => setAnticallPhone(e.target.value)}
            placeholder="Phone number with country code (e.g. 923001234567)"
            className="flex-1 min-w-[220px] px-3.5 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono tabular-nums text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Block Caller
          </button>
        </form>

        {anticallError && (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-3.5 py-2">
            {anticallError}
          </div>
        )}

        <div className="divide-y divide-white/[0.06]">
          {blockedCallers.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#8B84AD]">
              No individual callers blocked yet. Type <span className="font-mono text-white">.anticall on</span> inside any DM or add a number above.
            </div>
          ) : (
            blockedCallers.map((entry) => (
              <div key={entry.jid} className="py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono tabular-nums text-white">
                    +{entry.phone || entry.jid}
                  </span>
                  <span className="text-[#8B84AD]">·</span>
                  <span className="font-mono text-[#8B84AD] truncate max-w-[220px]">
                    {entry.jid}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveAnticall(entry.jid)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-rose-500/20 text-xs text-[#C4BFE0] hover:text-rose-200 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Allow Calls
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
