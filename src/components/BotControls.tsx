import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PhoneOff, Plus, Radio, Save, Send, Shield, ShieldAlert, Trash2 } from 'lucide-react';
import type {
  BlockedCallerEntry,
  BotConfigView,
  GroupConfig,
  VirusBlacklistEntry,
} from '../types/bot';

interface BotControlsProps {
  config: BotConfigView | null;
  groups: GroupConfig[];
  adminToken: string;
  onRefresh: () => Promise<void>;
}

const DEFAULT_BOT_CONFIG_FORM: BotConfigView = {
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
  antiStatusMentionGlobal: false,
  antiVirusGlobal: true,
  autoForwardIbToOpenGcs: false,
  autoReact: false,
  aiEnabled: false,
  singleTick: false,
  alwaysOnline: false,
  stickerPack: 'FADI KING MD',
  stickerAuthor: 'VIP BOT',
  menuImageUrl: '/assets/aistudio/IMG-20261114-WA0040_492a0008_492a0008.jpg',
  menuChannelJid: '',
  menuChannelName: 'FADI KING MD OFFICIAL',
  menuChannelUrl: '',
};

function safeNum(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBotConfigForm(cfg: Partial<BotConfigView>): BotConfigView {
  return {
    botName: typeof cfg.botName === 'string' ? cfg.botName : DEFAULT_BOT_CONFIG_FORM.botName,
    ownerNumber: typeof cfg.ownerNumber === 'string' ? cfg.ownerNumber : DEFAULT_BOT_CONFIG_FORM.ownerNumber,
    ownerName: typeof cfg.ownerName === 'string' ? cfg.ownerName : DEFAULT_BOT_CONFIG_FORM.ownerName,
    prefix: typeof cfg.prefix === 'string' ? cfg.prefix : DEFAULT_BOT_CONFIG_FORM.prefix,
    mode: cfg.mode === 'self' ? 'self' : 'public',
    vipOnlyPairing: Boolean(cfg.vipOnlyPairing ?? DEFAULT_BOT_CONFIG_FORM.vipOnlyPairing),
    maxPairAttempts: safeNum(cfg.maxPairAttempts, DEFAULT_BOT_CONFIG_FORM.maxPairAttempts),
    pairWindowMinutes: safeNum(cfg.pairWindowMinutes, DEFAULT_BOT_CONFIG_FORM.pairWindowMinutes),
    pairCooldownSeconds: safeNum(cfg.pairCooldownSeconds, DEFAULT_BOT_CONFIG_FORM.pairCooldownSeconds),
    cmdCooldownSeconds: safeNum(cfg.cmdCooldownSeconds, DEFAULT_BOT_CONFIG_FORM.cmdCooldownSeconds),
    groupCmdCooldownSeconds: safeNum(cfg.groupCmdCooldownSeconds, DEFAULT_BOT_CONFIG_FORM.groupCmdCooldownSeconds),
    tagCooldownSeconds: safeNum(cfg.tagCooldownSeconds, DEFAULT_BOT_CONFIG_FORM.tagCooldownSeconds),
    tagMaxPerHour: safeNum(cfg.tagMaxPerHour, DEFAULT_BOT_CONFIG_FORM.tagMaxPerHour),
    autoReadMessages: Boolean(cfg.autoReadMessages ?? DEFAULT_BOT_CONFIG_FORM.autoReadMessages),
    autoStatusSeen: Boolean(cfg.autoStatusSeen ?? DEFAULT_BOT_CONFIG_FORM.autoStatusSeen),
    autoTyping: Boolean(cfg.autoTyping ?? DEFAULT_BOT_CONFIG_FORM.autoTyping),
    autoRecording: Boolean(cfg.autoRecording ?? DEFAULT_BOT_CONFIG_FORM.autoRecording),
    broadcastDelayMs: safeNum(cfg.broadcastDelayMs, DEFAULT_BOT_CONFIG_FORM.broadcastDelayMs),
    broadcastDelayMinMs: safeNum(cfg.broadcastDelayMinMs, DEFAULT_BOT_CONFIG_FORM.broadcastDelayMinMs),
    broadcastDelayMaxMs: safeNum(cfg.broadcastDelayMaxMs, DEFAULT_BOT_CONFIG_FORM.broadcastDelayMaxMs),
    maxBroadcastTargets: safeNum(cfg.maxBroadcastTargets, DEFAULT_BOT_CONFIG_FORM.maxBroadcastTargets),
    maxReconnectAttempts: safeNum(cfg.maxReconnectAttempts, DEFAULT_BOT_CONFIG_FORM.maxReconnectAttempts),
    humanDelayEnabled: Boolean(cfg.humanDelayEnabled ?? DEFAULT_BOT_CONFIG_FORM.humanDelayEnabled),
    humanDelayMinMs: safeNum(cfg.humanDelayMinMs, DEFAULT_BOT_CONFIG_FORM.humanDelayMinMs),
    humanDelayMaxMs: safeNum(cfg.humanDelayMaxMs, DEFAULT_BOT_CONFIG_FORM.humanDelayMaxMs),
    autoJoinGroupInvite:
      typeof cfg.autoJoinGroupInvite === 'string'
        ? cfg.autoJoinGroupInvite
        : DEFAULT_BOT_CONFIG_FORM.autoJoinGroupInvite,
    autoJoinChannelInvite:
      typeof cfg.autoJoinChannelInvite === 'string'
        ? cfg.autoJoinChannelInvite
        : DEFAULT_BOT_CONFIG_FORM.autoJoinChannelInvite,
    sendConnectSelfMessage: Boolean(
      cfg.sendConnectSelfMessage ?? DEFAULT_BOT_CONFIG_FORM.sendConnectSelfMessage
    ),
    anticallGlobal: Boolean(cfg.anticallGlobal ?? DEFAULT_BOT_CONFIG_FORM.anticallGlobal),
    antiScamGlobal: Boolean(cfg.antiScamGlobal ?? DEFAULT_BOT_CONFIG_FORM.antiScamGlobal),
    antiScamBlockAllStickers: Boolean(
      cfg.antiScamBlockAllStickers ?? DEFAULT_BOT_CONFIG_FORM.antiScamBlockAllStickers
    ),
    antiStatusMentionGlobal: Boolean(
      cfg.antiStatusMentionGlobal ?? DEFAULT_BOT_CONFIG_FORM.antiStatusMentionGlobal
    ),
    antiVirusGlobal: Boolean(
      cfg.antiVirusGlobal ?? DEFAULT_BOT_CONFIG_FORM.antiVirusGlobal
    ),
    autoForwardIbToOpenGcs: Boolean(
      cfg.autoForwardIbToOpenGcs ?? DEFAULT_BOT_CONFIG_FORM.autoForwardIbToOpenGcs
    ),
    autoReact: Boolean(cfg.autoReact ?? DEFAULT_BOT_CONFIG_FORM.autoReact),
    aiEnabled: Boolean(cfg.aiEnabled ?? DEFAULT_BOT_CONFIG_FORM.aiEnabled),
    singleTick: Boolean(cfg.singleTick ?? DEFAULT_BOT_CONFIG_FORM.singleTick),
    alwaysOnline: Boolean(cfg.alwaysOnline ?? DEFAULT_BOT_CONFIG_FORM.alwaysOnline),
    stickerPack:
      typeof cfg.stickerPack === 'string' ? cfg.stickerPack : DEFAULT_BOT_CONFIG_FORM.stickerPack,
    stickerAuthor:
      typeof cfg.stickerAuthor === 'string'
        ? cfg.stickerAuthor
        : DEFAULT_BOT_CONFIG_FORM.stickerAuthor,
    menuImageUrl:
      typeof cfg.menuImageUrl === 'string' ? cfg.menuImageUrl : DEFAULT_BOT_CONFIG_FORM.menuImageUrl,
    menuChannelJid:
      typeof cfg.menuChannelJid === 'string'
        ? cfg.menuChannelJid
        : DEFAULT_BOT_CONFIG_FORM.menuChannelJid,
    menuChannelName:
      typeof cfg.menuChannelName === 'string'
        ? cfg.menuChannelName
        : DEFAULT_BOT_CONFIG_FORM.menuChannelName,
    menuChannelUrl:
      typeof cfg.menuChannelUrl === 'string'
        ? cfg.menuChannelUrl
        : DEFAULT_BOT_CONFIG_FORM.menuChannelUrl,
  };
}

export function BotControls({ config, groups, adminToken, onRefresh }: BotControlsProps) {
  const [form, setForm] = useState<BotConfigView>(() =>
    config ? normalizeBotConfigForm(config) : DEFAULT_BOT_CONFIG_FORM
  );
  const isDirtyRef = useRef(false);
  const lastSyncedRef = useRef<string | null>(
    config ? JSON.stringify(normalizeBotConfigForm(config)) : null
  );
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastFeedback, setBroadcastFeedback] = useState<string | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);

  const [newGroupId, setNewGroupId] = useState('');

  const [blockedCallers, setBlockedCallers] = useState<BlockedCallerEntry[]>([]);
  const [anticallPhone, setAnticallPhone] = useState('');
  const [anticallError, setAnticallError] = useState<string | null>(null);
  const [virusBlacklist, setVirusBlacklist] = useState<VirusBlacklistEntry[]>([]);

  function updateForm(patch: Partial<BotConfigView>) {
    isDirtyRef.current = true;
    setForm((prev) => ({ ...prev, ...patch }));
  }

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

  const fetchAntivirus = useCallback(async () => {
    try {
      const res = await fetch('/api/antivirus', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && Array.isArray(data.blacklist)) {
        setVirusBlacklist(data.blacklist);
      }
    } catch {
      // Ignore network hiccup
    }
  }, [adminToken]);

  useEffect(() => {
    if (!config || isDirtyRef.current) return;
    const normalized = normalizeBotConfigForm(config);
    const sig = JSON.stringify(normalized);
    if (sig !== lastSyncedRef.current) {
      lastSyncedRef.current = sig;
      setForm(normalized);
    }
  }, [config]);

  useEffect(() => {
    void fetchAnticall();
    void fetchAntivirus();
  }, [fetchAnticall, fetchAntivirus]);

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
      if (res.ok && data.ok) {
        isDirtyRef.current = false;
        if (data.config) {
          const normalized = normalizeBotConfigForm(data.config);
          lastSyncedRef.current = JSON.stringify(normalized);
          setForm(normalized);
        }
        setSaveFeedback('Configuration saved to persistent database (survives restarts & redeploys).');
        await onRefresh();
      } else {
        setSaveFeedback(data.error || 'Failed to save configuration.');
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
    field:
      | 'welcome'
      | 'goodbye'
      | 'antiScam'
      | 'antiStatusMention'
      | 'antiVirus'
      | 'aiEnabled'
      | 'antiAdd'
      | 'antiForward'
      | 'antiMedia'
      | 'antiSticker'
      | 'antiBot'
      | 'antiPayMsg'
      | 'antiAdminKick'
      | 'gcStatusRemove'
      | 'slowModeSeconds',
    value: boolean | number
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
        antiStatusMention: true,
        aiEnabled: false,
        welcome: false,
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

  async function handleRemoveAntivirusBlacklist(target: string) {
    await fetch(`/api/antivirus/${encodeURIComponent(target)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await fetchAntivirus();
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
                onChange={(e) => updateForm({ botName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Owner Name</label>
              <input
                type="text"
                value={form.ownerName}
                onChange={(e) => updateForm({ ownerName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Owner Number</label>
              <input
                type="text"
                value={form.ownerNumber}
                onChange={(e) => updateForm({ ownerNumber: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Command Prefix</label>
              <input
                type="text"
                maxLength={3}
                value={form.prefix}
                onChange={(e) => updateForm({ prefix: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Bot Access Mode</label>
              <select
                value={form.mode}
                onChange={(e) => updateForm({ mode: e.target.value as 'public' | 'self' })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
              >
                <option value="public">Public (Everyone)</option>
                <option value="self">Private (Owner Only · Pairing Open)</option>
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
                onChange={(e) => updateForm({ broadcastDelayMinMs: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ broadcastDelayMaxMs: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ maxBroadcastTargets: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ pairCooldownSeconds: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ maxPairAttempts: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ pairWindowMinutes: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ cmdCooldownSeconds: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ groupCmdCooldownSeconds: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ tagCooldownSeconds: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ tagMaxPerHour: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ maxReconnectAttempts: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">Sticker Pack Name</label>
              <input
                type="text"
                value={form.stickerPack}
                onChange={(e) => updateForm({ stickerPack: e.target.value })}
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
                onChange={(e) => updateForm({ humanDelayMinMs: Number(e.target.value) })}
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
                onChange={(e) => updateForm({ humanDelayMaxMs: Number(e.target.value) })}
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
                  onChange={(e) => updateForm({ autoJoinGroupInvite: e.target.value })}
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
                  onChange={(e) => updateForm({ autoJoinChannelInvite: e.target.value })}
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
                  onChange={(e) => updateForm({ humanDelayEnabled: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Human-Like Anti-Ban Delay
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.sendConnectSelfMessage}
                  onChange={(e) => updateForm({ sendConnectSelfMessage: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Self-DM Connect Message
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.anticallGlobal}
                  onChange={(e) => updateForm({ anticallGlobal: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Global Anti-Call Reject
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.vipOnlyPairing}
                  onChange={(e) => updateForm({ vipOnlyPairing: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Enforce VIP-Only Pairing Gate
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoReadMessages}
                  onChange={(e) => updateForm({ autoReadMessages: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-Read Incoming Chats
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoStatusSeen}
                  onChange={(e) => updateForm({ autoStatusSeen: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-View WhatsApp Statuses
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoTyping}
                  onChange={(e) => updateForm({ autoTyping: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-Typing Presence
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoRecording}
                  onChange={(e) => updateForm({ autoRecording: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-Recording Presence
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.antiScamGlobal}
                  onChange={(e) => updateForm({ antiScamGlobal: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Global Anti-Scam Shield (Stickers, Gaaliyan & Spam)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.antiScamBlockAllStickers}
                  onChange={(e) => updateForm({ antiScamBlockAllStickers: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Strict Mode: Delete Non-Admin Stickers
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.antiStatusMentionGlobal}
                  onChange={(e) => updateForm({ antiStatusMentionGlobal: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Global Anti-Mention Status (Delete Group Status Mentions)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.antiVirusGlobal ?? true)}
                  onChange={(e) => updateForm({ antiVirusGlobal: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Anti-Virus & Zero-Day Crash Shield (Owner/VIP IB + Groups)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoForwardIbToOpenGcs}
                  onChange={(e) => updateForm({ autoForwardIbToOpenGcs: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto IB → Open GCs (Anti-Delete Protected Broadcast)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoReact}
                  onChange={(e) => updateForm({ autoReact: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Auto-React Incoming Messages
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.aiEnabled}
                  onChange={(e) => updateForm({ aiEnabled: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                AI Assistant Auto-Replies (.ai on/off)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.singleTick}
                  onChange={(e) => updateForm({ singleTick: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Single Tick Shield (Suppress Blue Ticks & Presence — WA Ban Risk)
              </label>

              <label className="inline-flex items-center gap-2.5 text-sm text-[#D5D0ED] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.alwaysOnline}
                  onChange={(e) => updateForm({ alwaysOnline: e.target.checked })}
                  className="w-4 h-4 accent-[#8B5CF6]"
                />
                Always Online (.alwaysonline on/off)
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

                      <button
                        type="button"
                        onClick={() =>
                          toggleGroupSetting(
                            g.groupId,
                            'antiStatusMention',
                            !(g.antiStatusMention ?? form.antiStatusMentionGlobal)
                          )
                        }
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                          (g.antiStatusMention ?? form.antiStatusMentionGlobal)
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white/[0.06] text-[#9E97C2]'
                        }`}
                      >
                        Anti-Mention Status: {(g.antiStatusMention ?? form.antiStatusMentionGlobal) ? 'On' : 'Off'}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          toggleGroupSetting(
                            g.groupId,
                            'antiVirus',
                            !(g.antiVirus ?? form.antiVirusGlobal ?? true)
                          )
                        }
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                          (g.antiVirus ?? form.antiVirusGlobal ?? true)
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white/[0.06] text-[#9E97C2]'
                        }`}
                      >
                        Anti-Virus: {(g.antiVirus ?? form.antiVirusGlobal ?? true) ? 'On' : 'Off'}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          toggleGroupSetting(g.groupId, 'aiEnabled', !Boolean(g.aiEnabled))
                        }
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                          Boolean(g.aiEnabled)
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white/[0.06] text-[#9E97C2]'
                        }`}
                      >
                        AI Chat: {Boolean(g.aiEnabled) ? 'On' : 'Off'}
                      </button>

                      {(['antiAdd', 'antiForward', 'antiMedia', 'antiSticker', 'antiBot', 'antiPayMsg', 'antiAdminKick', 'gcStatusRemove'] as const).map(
                        (field) => {
                          const labels: Record<typeof field, string> = {
                            antiAdd: 'Anti-Add',
                            antiForward: 'Anti-Forward',
                            antiMedia: 'Anti-Media',
                            antiSticker: 'Anti-Sticker',
                            antiBot: 'Anti-Bot',
                            antiPayMsg: 'Anti-PayMsg',
                            antiAdminKick: 'Anti-AdminKick',
                            gcStatusRemove: 'GC Status/Link Remove',
                          };
                          const active = Boolean(g[field]);
                          return (
                            <button
                              key={field}
                              type="button"
                              onClick={() => toggleGroupSetting(g.groupId, field, !active)}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                                active
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-white/[0.06] text-[#9E97C2]'
                              }`}
                            >
                              {labels[field]}: {active ? 'On' : 'Off'}
                            </button>
                          );
                        }
                      )}

                      <select
                        value={String(g.slowModeSeconds ?? 0)}
                        onChange={(e) =>
                          toggleGroupSetting(g.groupId, 'slowModeSeconds', Number(e.target.value))
                        }
                        aria-label={`Slow mode for ${g.groupId}`}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border border-white/[0.1] focus:outline-none cursor-pointer ${
                          (g.slowModeSeconds ?? 0) > 0
                            ? 'bg-amber-600 text-white'
                            : 'bg-[#0A0714] text-[#9E97C2]'
                        }`}
                      >
                        <option value="0">Slow Mode: Off</option>
                        <option value="10">Slow Mode: 10s</option>
                        <option value="30">Slow Mode: 30s</option>
                        <option value="60">Slow Mode: 60s</option>
                      </select>

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

      {/* Anti-Virus & Zero-Day Threat Blacklist */}
      <section className="glass-surface rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-4 h-4 text-rose-400" />
            <div>
              <h3 className="text-base font-semibold text-white">
                Anti-Virus & Zero-Day Threat Blacklist
              </h3>
              <p className="text-xs text-[#9E97C2]">
                Senders caught transmitting crash bombs, invisible unicode floods, or malformed protobuf payloads are purged and permanently blacklisted.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono tabular-nums text-[#C4BFE0]">
            Shield: {(form.antiVirusGlobal ?? true) ? 'ACTIVE' : 'PAUSED'} · Blacklisted: {virusBlacklist.length}
          </span>
        </div>

        <div className="divide-y divide-white/[0.06]">
          {virusBlacklist.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#8B84AD]">
              No crash attackers blacklisted. Manage via WhatsApp with <span className="font-mono text-white">.antivirus list</span> or <span className="font-mono text-white">.antivirus unblock</span>.
            </div>
          ) : (
            virusBlacklist.map((entry) => (
              <div key={entry.jid} className="py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5 text-xs min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono tabular-nums text-white font-semibold">
                      +{entry.number || entry.jid}
                    </span>
                    <span className="text-[#8B84AD]">·</span>
                    <span className="font-mono text-rose-300">
                      {entry.categories.join(', ')}
                    </span>
                    <span className="text-[#8B84AD]">·</span>
                    <span className="font-mono tabular-nums text-[#9E97C2]">
                      {entry.hits}x · {entry.blockedAt.slice(0, 10)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#9E97C2] truncate max-w-[560px]">
                    {entry.reason}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveAntivirusBlacklist(entry.jid)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-emerald-500/20 text-xs text-[#C4BFE0] hover:text-emerald-200 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Unblacklist
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
