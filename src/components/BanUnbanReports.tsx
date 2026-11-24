import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Ban,
  CheckCircle2,
  Mail,
  Play,
  Plus,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  ReportActionType,
  ReportExecutionLog,
  ReportSettingsView,
  ReportTemplate,
} from '../types/bot';

interface BanUnbanReportsProps {
  prefix: string;
  adminToken: string;
  onRefresh: () => Promise<void>;
}

const DEFAULT_SETTINGS: ReportSettingsView = {
  banRepeatCount: 1,
  unbanRepeatCount: 1,
  blockOnBan: true,
  unblockOnUnban: true,
  sendSpamStanzaOnBan: true,
  echoReportsInChat: true,
  smtpEnabled: false,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  hasSmtpPass: false,
  supportRecipients:
    'support@support.whatsapp.com, smb_web@support.whatsapp.com, android_web@support.whatsapp.com',
};

const SAMPLE_BAN_BLOCK = `Hello WhatsApp Team,
Please urgently review and suspend the WhatsApp account {number} for sending repeated spam, abusive messages, and violating WhatsApp Terms of Service.
Reason: {reason}
---
Urgent Abuse Report: Account {number} is involved in mass spamming, scam links, and harassment across groups. Please restrict/ban {number} immediately.
---
WhatsApp Safety Violation Notice: The user {number} has been reported multiple times for automated spam and unauthorized behavior ({date}). Please take strict action.`;

const SAMPLE_UNBAN_BLOCK = `Hello WhatsApp Support Team,
My WhatsApp number {number} was banned by mistake. I always follow WhatsApp Terms of Service and did not send spam or automated messages. Please review and restore my account {number} as soon as possible. Thank you.
---
Appeal for Account Review: Dear WhatsApp Support, my personal number {number} has been mistakenly suspended. I rely on it for daily family and work communication. Kindly unban {number}.
---
Urgent Account Recovery Request: Please reactivate {number}. Any flagged activity was unintentional and I assure full compliance with WhatsApp guidelines going forward.`;

export function BanUnbanReports({ prefix, adminToken }: BanUnbanReportsProps) {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [settings, setSettings] = useState<ReportSettingsView>(DEFAULT_SETTINGS);
  const [smtpPassInput, setSmtpPassInput] = useState('');
  const [logs, setLogs] = useState<ReportExecutionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [activeEditor, setActiveEditor] = useState<ReportActionType>('ban');
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');

  const [savingSettings, setSavingSettings] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);

  const [runNumber, setRunNumber] = useState('');
  const [runReason, setRunReason] = useState('');
  const [runType, setRunType] = useState<ReportActionType>('ban');
  const [runningReport, setRunningReport] = useState(false);

  const fetchReports = useCallback(async () => {
    try {
      const res = await fetch('/api/reports', {
        headers: { Authorization: `Bearer ${adminToken}` },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
        if (data.settings) setSettings(data.settings);
        setLogs(Array.isArray(data.logs) ? data.logs : []);
      }
    } catch {
      // Ignore transient poll error
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    void fetchReports();
  }, [fetchReports]);

  async function handleAddTemplates(e: FormEvent) {
    e.preventDefault();
    const raw = newBody.trim();
    if (!raw) return;
    setAdding(true);
    setFeedback(null);
    try {
      const hasMultipleSeparator = /\n\s*(?:---+|===+)\s*\n/.test(raw);
      const res = await fetch('/api/reports/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(
          hasMultipleSeparator
            ? { type: activeEditor, rawBlock: raw }
            : { type: activeEditor, title: newTitle.trim() || undefined, body: raw }
        ),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const count = Array.isArray(data.created) ? data.created.length : 1;
        setNewTitle('');
        setNewBody('');
        setFeedback(
          `Saved ${count} ${activeEditor.toUpperCase()} report template(s). They will automatically fire whenever ${prefix}${activeEditor} <number> is executed.`
        );
        await fetchReports();
      } else {
        setFeedback(data.error || 'Failed to add report template.');
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleInsertSamples(type: ReportActionType) {
    const sample = type === 'ban' ? SAMPLE_BAN_BLOCK : SAMPLE_UNBAN_BLOCK;
    setAdding(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/reports/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ type, rawBlock: sample }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setFeedback(`Added ${data.created?.length || 3} editable sample ${type.toUpperCase()} reports.`);
        await fetchReports();
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleToggleTemplate(tpl: ReportTemplate) {
    await fetch(`/api/reports/templates/${encodeURIComponent(tpl.id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ enabled: !tpl.enabled }),
    });
    await fetchReports();
  }

  async function handleSaveEdit(id: string) {
    const res = await fetch(`/api/reports/templates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ title: editTitle, body: editBody }),
    });
    if (res.ok) {
      setEditingId(null);
      await fetchReports();
    }
  }

  async function handleDeleteTemplate(id: string) {
    await fetch(`/api/reports/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await fetchReports();
  }

  async function handleClearType(type: ReportActionType) {
    await fetch(`/api/reports/templates/type/${type}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await fetchReports();
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setFeedback(null);
    try {
      const payload: Record<string, unknown> = { ...settings };
      if (smtpPassInput.trim()) {
        payload.smtpPass = smtpPassInput.trim();
      }
      const res = await fetch('/api/reports/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSettings(data.settings);
        setSmtpPassInput('');
        setFeedback('Ban & Unban multi-report engine settings saved.');
      } else {
        setFeedback(data.error || 'Failed to save settings.');
      }
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestSmtp() {
    setTestingSmtp(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/reports/test-smtp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setFeedback(data.detail || (data.ok ? 'SMTP test succeeded.' : 'SMTP test failed.'));
    } finally {
      setTestingSmtp(false);
    }
  }

  async function handleRunReportNow(e: FormEvent) {
    e.preventDefault();
    if (!runNumber.trim()) return;
    setRunningReport(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/reports/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: runType,
          number: runNumber.trim(),
          reason: runReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setFeedback(`Executed: ${data.log.summary}`);
        await fetchReports();
      } else {
        setFeedback(data.error || 'Failed to execute report.');
      }
    } finally {
      setRunningReport(false);
    }
  }

  async function handleClearLogs() {
    await fetch('/api/reports/logs', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await fetchReports();
  }

  const banTemplates = templates.filter((t) => t.type === 'ban');
  const unbanTemplates = templates.filter((t) => t.type === 'unban');
  const visibleTemplates = activeEditor === 'ban' ? banTemplates : unbanTemplates;

  return (
    <div className="space-y-6">
      {feedback && (
        <div className="rounded-xl bg-[#8B5CF6]/15 border border-[#8B5CF6]/35 px-4 py-3 text-xs text-white">
          {feedback}
        </div>
      )}

      {/* Main Paste & Manage Reports Card */}
      <section className="glass-surface rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            {activeEditor === 'ban' ? (
              <Ban className="w-4 h-4 text-rose-400" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            )}
            <div>
              <h2 className="text-lg font-semibold text-white">
                Ban & Unban Multi-Report Templates
              </h2>
              <p className="text-xs text-[#9E97C2]">
                Paste your custom <span className="font-mono text-white">{prefix}ban</span> and{' '}
                <span className="font-mono text-white">{prefix}unban</span> reports below. When
                either command is run on any number, all enabled reports fire automatically in
                multiple rounds.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
            <button
              type="button"
              onClick={() => setActiveEditor('ban')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                activeEditor === 'ban'
                  ? 'bg-rose-500/80 text-white'
                  : 'text-[#A9A2C8] hover:text-white'
              }`}
            >
              .ban Reports ({banTemplates.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveEditor('unban')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                activeEditor === 'unban'
                  ? 'bg-emerald-500/80 text-white'
                  : 'text-[#A9A2C8] hover:text-white'
              }`}
            >
              .unban Reports ({unbanTemplates.length})
            </button>
          </div>
        </div>

        {/* Paste Report Form */}
        <form onSubmit={handleAddTemplates} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={`Optional label (e.g. ${activeEditor === 'ban' ? 'Spam Abuse #1' : 'Mistaken Ban Appeal #1'})`}
              className="sm:col-span-2 px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
            <button
              type="button"
              onClick={() => void handleInsertSamples(activeEditor)}
              disabled={adding}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-medium text-[#D5D0ED] cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#A78BFA]" />
              Load 3 Sample {activeEditor === 'ban' ? 'Ban' : 'Unban'} Reports
            </button>
          </div>

          <textarea
            rows={5}
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder={
              activeEditor === 'ban'
                ? 'Paste your .ban report text here... Use {number} where the banned phone number should appear. To paste multiple reports at once, separate each report with --- on its own line.'
                : 'Paste your .unban report/appeal text here... Use {number} where the target phone number should appear. To paste multiple reports at once, separate each report with --- on its own line.'
            }
            className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs leading-relaxed text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] text-[#9E97C2]">
              Placeholders: <span className="font-mono text-white">{'{number}'}</span> (+92300...),{' '}
              <span className="font-mono text-white">{'{digits}'}</span>,{' '}
              <span className="font-mono text-white">{'{reason}'}</span>,{' '}
              <span className="font-mono text-white">{'{date}'}</span> · Separate multiple reports
              with <span className="font-mono text-white">---</span>
            </div>
            <div className="flex items-center gap-2">
              {visibleTemplates.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleClearType(activeEditor)}
                  className="px-3 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-xs font-medium text-rose-200 cursor-pointer"
                >
                  Clear All {activeEditor.toUpperCase()}
                </button>
              )}
              <button
                type="submit"
                disabled={adding || !newBody.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-xs font-semibold text-white cursor-pointer disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                {adding ? 'Saving...' : `Add ${activeEditor.toUpperCase()} Report(s)`}
              </button>
            </div>
          </div>
        </form>

        {/* Saved Templates List */}
        <div className="space-y-2.5 pt-2">
          {loading ? (
            <div className="py-6 text-center text-xs text-[#8B84AD]">Loading report templates...</div>
          ) : visibleTemplates.length === 0 ? (
            <div className="py-8 text-center text-xs text-[#8B84AD] rounded-xl bg-white/[0.02] border border-dashed border-white/[0.08]">
              No <span className="font-mono text-white">{prefix}{activeEditor}</span> reports pasted
              yet. Paste one or multiple reports above and click Add!
            </div>
          ) : (
            visibleTemplates.map((tpl, idx) => (
              <div
                key={tpl.id}
                className="p-4 rounded-xl bg-[#0B0816]/85 border border-white/[0.08] space-y-2.5"
              >
                {editingId === tpl.id ? (
                  <div className="space-y-2.5">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0714] border border-white/[0.12] text-xs text-white"
                    />
                    <textarea
                      rows={4}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#0A0714] border border-white/[0.12] text-xs text-white"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveEdit(tpl.id)}
                        className="px-3 py-1.5 rounded-lg bg-[#8B5CF6] text-xs font-semibold text-white cursor-pointer"
                      >
                        Save Changes
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1.5 rounded-lg bg-white/[0.07] text-xs text-[#C4BFE0] cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-[#9E97C2]">#{idx + 1}</span>
                        <span className="text-xs font-semibold text-white">{tpl.title}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleToggleTemplate(tpl)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer ${
                            tpl.enabled
                              ? 'bg-emerald-500/20 text-emerald-200'
                              : 'bg-white/[0.06] text-[#8B84AD]'
                          }`}
                        >
                          {tpl.enabled ? 'Active' : 'Paused'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(tpl.id);
                            setEditTitle(tpl.title);
                            setEditBody(tpl.body);
                          }}
                          className="px-2.5 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[11px] text-[#D5D0ED] cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteTemplate(tpl.id)}
                          aria-label="Delete report template"
                          className="p-1.5 rounded-md bg-white/[0.05] hover:bg-rose-500/20 text-[#9E97C2] hover:text-rose-200 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed text-[#D5D0ED] whitespace-pre-wrap">
                      {tpl.body}
                    </p>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Engine Multipliers + Direct Runner + SMTP Dispatch */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="glass-surface rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 pb-4 border-b border-white/[0.07]">
            <ShieldAlert className="w-4 h-4 text-[#A78BFA]" />
            <h3 className="text-base font-semibold text-white">
              Multi-Report Settings & Support Email
            </h3>
          </div>

          <form onSubmit={handleSaveSettings} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-[#C4BFE0] mb-1">
                  .ban Repeat Multiplier (1–10x)
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.banRepeatCount}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      banRepeatCount: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                    }))
                  }
                  className="w-full px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[#C4BFE0] mb-1">
                  .unban Repeat Multiplier (1–10x)
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.unbanRepeatCount}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      unbanRepeatCount: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                    }))
                  }
                  className="w-full px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {(
                [
                  ['blockOnBan', 'Block target on WhatsApp (.ban)'],
                  ['unblockOnUnban', 'Unblock target on WhatsApp (.unban)'],
                  ['sendSpamStanzaOnBan', 'Fire WhatsApp Spam IQ stanzas (.ban)'],
                  ['echoReportsInChat', 'Show applied reports in chat reply'],
                ] as const
              ).map(([field, label]) => (
                <label
                  key={field}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] cursor-pointer text-xs text-[#D5D0ED]"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(settings[field])}
                    onChange={(e) => setSettings((s) => ({ ...s, [field]: e.target.checked }))}
                    className="accent-[#8B5CF6]"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            <div className="pt-3 border-t border-white/[0.07] space-y-3">
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-white">
                  <Mail className="w-3.5 h-3.5 text-[#A78BFA]" />
                  Auto-Email Reports to WhatsApp Support (SMTP)
                </span>
                <input
                  type="checkbox"
                  checked={settings.smtpEnabled}
                  onChange={(e) => setSettings((s) => ({ ...s, smtpEnabled: e.target.checked }))}
                  className="accent-[#8B5CF6]"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  type="text"
                  value={settings.smtpHost}
                  onChange={(e) => setSettings((s) => ({ ...s, smtpHost: e.target.value }))}
                  placeholder="smtp.gmail.com"
                  className="sm:col-span-2 px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white"
                />
                <input
                  type="number"
                  value={settings.smtpPort}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, smtpPort: Number(e.target.value) || 465 }))
                  }
                  placeholder="465"
                  className="px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="email"
                  value={settings.smtpUser}
                  onChange={(e) => setSettings((s) => ({ ...s, smtpUser: e.target.value }))}
                  placeholder="Sender Gmail / SMTP email"
                  className="px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white"
                />
                <input
                  type="password"
                  value={smtpPassInput}
                  onChange={(e) => setSmtpPassInput(e.target.value)}
                  placeholder={settings.hasSmtpPass ? '•••••••• (saved)' : 'App Password / SMTP pass'}
                  className="px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white"
                />
              </div>

              <input
                type="text"
                value={settings.supportRecipients}
                onChange={(e) => setSettings((s) => ({ ...s, supportRecipients: e.target.value }))}
                placeholder="support@support.whatsapp.com, smb_web@support.whatsapp.com"
                className="w-full px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="submit"
                disabled={savingSettings}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] text-xs font-semibold text-white cursor-pointer disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {savingSettings ? 'Saving...' : 'Save Report Settings'}
              </button>
              <button
                type="button"
                disabled={testingSmtp}
                onClick={() => void handleTestSmtp()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-medium text-[#D5D0ED] cursor-pointer disabled:opacity-50"
              >
                <Mail className="w-3.5 h-3.5" />
                {testingSmtp ? 'Testing...' : 'Test SMTP'}
              </button>
            </div>
          </form>
        </section>

        {/* Direct Runner & History */}
        <section className="glass-surface rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2 pb-4 border-b border-white/[0.07]">
            <div className="flex items-center gap-2.5">
              <Play className="w-4 h-4 text-[#A78BFA]" />
              <h3 className="text-base font-semibold text-white">
                Execute Ban / Unban Multi-Report
              </h3>
            </div>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearLogs()}
                className="text-[11px] text-[#9E97C2] hover:text-rose-300 cursor-pointer"
              >
                Clear History
              </button>
            )}
          </div>

          <form onSubmit={handleRunReportNow} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <select
                value={runType}
                onChange={(e) => setRunType(e.target.value === 'unban' ? 'unban' : 'ban')}
                className="px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white"
              >
                <option value="ban">.ban Report</option>
                <option value="unban">.unban Report</option>
              </select>
              <input
                type="text"
                required
                value={runNumber}
                onChange={(e) => setRunNumber(e.target.value)}
                placeholder="923001234567"
                className="sm:col-span-2 px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white"
              />
            </div>
            <div className="flex gap-2.5">
              <input
                type="text"
                value={runReason}
                onChange={(e) => setRunReason(e.target.value)}
                placeholder="Optional reason / note"
                className="flex-1 px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white"
              />
              <button
                type="submit"
                disabled={runningReport}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white cursor-pointer disabled:opacity-50 ${
                  runType === 'ban'
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                <Play className="w-3.5 h-3.5" />
                {runningReport ? 'Running...' : runType === 'ban' ? 'Run .ban' : 'Run .unban'}
              </button>
            </div>
          </form>

          <div className="space-y-2 max-h-80 overflow-y-auto divide-y divide-white/[0.06]">
            {logs.length === 0 ? (
              <div className="py-8 text-center text-xs text-[#8B84AD]">
                No Ban/Unban report executions logged yet.
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="pt-2.5 space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`font-mono font-semibold ${
                        log.type === 'ban' ? 'text-rose-300' : 'text-emerald-300'
                      }`}
                    >
                      {log.type.toUpperCase()} +{log.targetNumber}
                    </span>
                    <span className="font-mono text-[11px] text-[#8B84AD]">
                      {log.timestamp.slice(0, 19).replace('T', ' ')}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#D5D0ED]">{log.summary}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
