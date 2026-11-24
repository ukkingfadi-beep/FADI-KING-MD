import { useState, type FormEvent } from 'react';
import { Clock, Play, RotateCcw, Save, Search, Terminal, Timer, Trash2 } from 'lucide-react';
import type { CommandCategory, CommandItem } from '../types/bot';

interface CommandCenterProps {
  commands: CommandItem[];
  prefix: string;
  adminToken: string;
  onRefresh: () => Promise<void>;
}

const categoryLabels: Record<'all' | CommandCategory, string> = {
  all: 'All Commands',
  general: 'A. General',
  vip: 'B. VIP & Pairing',
  group: 'C. Group Admin',
  media: 'D. Media & Utility',
  owner: 'E. Owner',
};

const DELETE_PRESETS = [0, 5, 10, 30, 60];
const DELAY_PRESETS = [0, 2, 5, 10];

export function CommandCenter({ commands, prefix, adminToken, onRefresh }: CommandCenterProps) {
  const [activeCategory, setActiveCategory] = useState<'all' | CommandCategory>('all');
  const [search, setSearch] = useState('');
  const [consoleInput, setConsoleInput] = useState(`${prefix}menu`);
  const [consoleOutput, setConsoleOutput] = useState<string>(
    `Click "Run" on any command or enter "${prefix}menu" below to execute against the modular command handler.`
  );
  const [running, setRunning] = useState(false);

  const [drafts, setDrafts] = useState<
    Record<string, { delay: string; deleteAfter: string }>
  >({});
  const [savingCmd, setSavingCmd] = useState<string | null>(null);
  const [bulkDelay, setBulkDelay] = useState('0');
  const [bulkDeleteAfter, setBulkDeleteAfter] = useState('0');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [timingFeedback, setTimingFeedback] = useState<string | null>(null);

  const filtered = commands.filter((cmd) => {
    const matchesCat = activeCategory === 'all' || cmd.category === activeCategory;
    const q = search.trim().toLowerCase();
    const matchesQuery =
      !q ||
      cmd.name.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q) ||
      cmd.aliases.some((a) => a.toLowerCase().includes(q));
    return matchesCat && matchesQuery;
  });

  async function executeCommand(rawCmd: string) {
    setRunning(true);
    setConsoleInput(rawCmd);
    try {
      const res = await fetch('/api/commands/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ input: rawCmd }),
      });
      const data = await res.json();
      setConsoleOutput(data.output || 'No output returned.');
      await onRefresh();
    } catch {
      setConsoleOutput('Failed to execute command against server.');
    } finally {
      setRunning(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void executeCommand(consoleInput);
  }

  function getRowValues(cmd: CommandItem): { delay: string; deleteAfter: string } {
    const d = drafts[cmd.name];
    if (d) return d;
    return {
      delay: String(cmd.delaySeconds ?? 0),
      deleteAfter: String(cmd.deleteAfterSeconds ?? 0),
    };
  }

  function updateRowDraft(
    cmd: CommandItem,
    patch: Partial<{ delay: string; deleteAfter: string }>
  ) {
    const current = getRowValues(cmd);
    setDrafts((prev) => ({
      ...prev,
      [cmd.name]: { ...current, ...patch },
    }));
  }

  async function saveCommandTiming(
    cmd: CommandItem,
    override?: { delaySeconds?: number; deleteAfterSeconds?: number }
  ) {
    const row = getRowValues(cmd);
    const delaySeconds =
      override?.delaySeconds !== undefined
        ? override.delaySeconds
        : Math.max(0, Math.min(300, Math.floor(Number(row.delay) || 0)));
    const deleteAfterSeconds =
      override?.deleteAfterSeconds !== undefined
        ? override.deleteAfterSeconds
        : Math.max(0, Math.min(86400, Math.floor(Number(row.deleteAfter) || 0)));

    setSavingCmd(cmd.name);
    setTimingFeedback(null);
    try {
      const res = await fetch(`/api/commands/${encodeURIComponent(cmd.name)}/timing`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ delaySeconds, deleteAfterSeconds }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[cmd.name];
          return next;
        });
        setTimingFeedback(
          `Saved ${prefix}${cmd.name}: Delay ${data.timing.delaySeconds}s · Auto-Delete ${
            data.timing.deleteAfterSeconds > 0 ? `${data.timing.deleteAfterSeconds}s` : 'Off'
          }`
        );
        await onRefresh();
      } else {
        setTimingFeedback(data.error || `Failed to save timing for ${prefix}${cmd.name}.`);
      }
    } catch {
      setTimingFeedback(`Network error saving timing for ${prefix}${cmd.name}.`);
    } finally {
      setSavingCmd(null);
    }
  }

  async function applyBulkTiming(scope: 'all' | 'visible') {
    const targetNames =
      scope === 'visible'
        ? filtered.map((c) => c.name)
        : commands.map((c) => c.name);
    if (targetNames.length === 0) return;

    const delaySeconds = Math.max(0, Math.min(300, Math.floor(Number(bulkDelay) || 0)));
    const deleteAfterSeconds = Math.max(0, Math.min(86400, Math.floor(Number(bulkDeleteAfter) || 0)));

    setBulkSaving(true);
    setTimingFeedback(null);
    try {
      const res = await fetch('/api/commands/timing/bulk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          names: targetNames,
          delaySeconds,
          deleteAfterSeconds,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setDrafts((prev) => {
          const next = { ...prev };
          for (const n of targetNames) delete next[n];
          return next;
        });
        setTimingFeedback(
          `Applied Delay ${delaySeconds}s & Auto-Delete ${
            deleteAfterSeconds > 0 ? `${deleteAfterSeconds}s` : 'Off'
          } to ${data.count} ${scope === 'visible' ? 'visible' : 'total'} command(s).`
        );
        await onRefresh();
      } else {
        setTimingFeedback(data.error || 'Failed to apply bulk command timings.');
      }
    } catch {
      setTimingFeedback('Network error applying bulk command timings.');
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Live Command Console */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-4 h-4 text-[#A78BFA]" />
            <h2 className="text-lg font-semibold text-white">Live Command Console</h2>
          </div>
          <span className="text-xs text-[#9E97C2]">
            Active Prefix <span className="font-mono text-white">{prefix}</span>
          </span>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={consoleInput}
            onChange={(e) => setConsoleInput(e.target.value)}
            placeholder={`${prefix}menu`}
            className="flex-1 px-4 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] font-mono text-sm text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
          />
          <button
            type="submit"
            disabled={running}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {running ? 'Running...' : 'Execute'}
          </button>
        </form>

        <pre className="mt-4 p-4 rounded-xl bg-[#090612] border border-white/[0.07] font-mono text-xs leading-relaxed text-[#E2DCF8] whitespace-pre-wrap max-h-64 overflow-y-auto">
          {consoleOutput}
        </pre>
      </section>

      {/* Modular Command Directory + Delay & Auto-Delete Controls */}
      <section className="glass-surface rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.07]">
          <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
            {(['all', 'general', 'vip', 'group', 'media', 'owner'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeCategory === cat
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#A9A2C8] hover:text-white'
                }`}
              >
                {categoryLabels[cat]}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search commands..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.08] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
          </div>
        </div>

        {/* Bulk Timing Controls for All Admin Panel Commands */}
        <div className="rounded-xl bg-[#0B0816] border border-white/[0.08] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-[#A78BFA]" />
              <span className="text-xs font-semibold text-white">
                Command Delay & Auto-Delete Timers (All Commands)
              </span>
            </div>
            <span className="text-[11px] text-[#9E97C2]">
              Delay pauses before reply; Delete removes bot replies automatically after X seconds.
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            {/* Bulk Delay */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium text-[#C4BFE0]">
                Delay Time (sec)
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={bulkDelay}
                  onChange={(e) => setBulkDelay(e.target.value)}
                  className="w-20 px-2.5 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.1] font-mono tabular-nums text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                />
                {DELAY_PRESETS.map((sec) => (
                  <button
                    key={`bd-${sec}`}
                    type="button"
                    onClick={() => setBulkDelay(String(sec))}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-mono cursor-pointer transition-colors ${
                      Number(bulkDelay) === sec
                        ? 'bg-[#8B5CF6] text-white'
                        : 'bg-white/[0.06] text-[#B6AFD4] hover:text-white'
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            {/* Bulk Auto-Delete */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium text-[#C4BFE0]">
                Auto-Delete Time (sec)
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={bulkDeleteAfter}
                  onChange={(e) => setBulkDeleteAfter(e.target.value)}
                  className="w-20 px-2.5 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.1] font-mono tabular-nums text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                />
                {DELETE_PRESETS.map((sec) => (
                  <button
                    key={`bdel-${sec}`}
                    type="button"
                    onClick={() => setBulkDeleteAfter(String(sec))}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-mono cursor-pointer transition-colors ${
                      Number(bulkDeleteAfter) === sec
                        ? 'bg-rose-600 text-white'
                        : 'bg-white/[0.06] text-[#B6AFD4] hover:text-white'
                    }`}
                  >
                    {sec === 0 ? 'Off' : `${sec}s`}
                  </button>
                ))}
              </div>
            </div>

            {/* Apply Buttons */}
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              {(activeCategory !== 'all' || search.trim() !== '') && (
                <button
                  type="button"
                  disabled={bulkSaving || filtered.length === 0}
                  onClick={() => void applyBulkTiming('visible')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Clock className="w-3.5 h-3.5 text-[#A78BFA]" />
                  Apply to Visible ({filtered.length})
                </button>
              )}
              <button
                type="button"
                disabled={bulkSaving || commands.length === 0}
                onClick={() => void applyBulkTiming('all')}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {bulkSaving ? 'Applying...' : `Set All Commands (${commands.length})`}
              </button>
            </div>
          </div>

          {timingFeedback && (
            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-3 py-2">
              {timingFeedback}
            </div>
          )}
        </div>

        <div className="divide-y divide-white/[0.06]">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-[#8B84AD]">
              No commands match your search.
            </div>
          ) : (
            filtered.map((cmd) => {
              const row = getRowValues(cmd);
              const savedDelay = cmd.delaySeconds ?? 0;
              const savedDel = cmd.deleteAfterSeconds ?? 0;
              const hasChanges =
                Number(row.delay) !== savedDelay || Number(row.deleteAfter) !== savedDel;
              const isSaving = savingCmd === cmd.name;

              return (
                <div
                  key={cmd.name}
                  className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono font-semibold text-white">
                        {prefix}
                        {cmd.name}
                      </span>
                      {cmd.aliases.length > 0 && (
                        <span className="text-xs font-mono text-[#948DB8]">
                          ({cmd.aliases.map((a) => `${prefix}${a}`).join(', ')})
                        </span>
                      )}
                      <span aria-hidden="true" className="text-[#6F6891]">·</span>
                      <span className="text-xs text-[#A78BFA] capitalize">
                        {cmd.category}
                      </span>
                      {cmd.ownerOnly && (
                        <>
                          <span aria-hidden="true" className="text-[#6F6891]">·</span>
                          <span className="text-xs text-amber-300">Owner Only</span>
                        </>
                      )}
                      {cmd.groupOnly && (
                        <>
                          <span aria-hidden="true" className="text-[#6F6891]">·</span>
                          <span className="text-xs text-[#9E97C2]">Group Only</span>
                        </>
                      )}
                      {savedDelay > 0 && (
                        <>
                          <span aria-hidden="true" className="text-[#6F6891]">·</span>
                          <span className="text-xs font-mono text-sky-300">
                            Delay {savedDelay}s
                          </span>
                        </>
                      )}
                      {savedDel > 0 && (
                        <>
                          <span aria-hidden="true" className="text-[#6F6891]">·</span>
                          <span className="text-xs font-mono text-rose-300">
                            Auto-Del {savedDel}s
                          </span>
                        </>
                      )}
                    </div>
                    <p className="text-xs text-[#B6AFD4]">{cmd.description}</p>
                    <div className="text-[11px] font-mono text-[#7C759E]">
                      Usage: {prefix}
                      {cmd.usage}
                    </div>
                  </div>

                  {/* Per-Command Delay, Delete Time & Test Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <div className="flex items-center gap-1.5 bg-[#0A0714] border border-white/[0.08] rounded-lg px-2 py-1">
                      <Clock className="w-3 h-3 text-sky-300 shrink-0" />
                      <span className="text-[11px] text-[#9E97C2]">Delay</span>
                      <input
                        type="number"
                        min={0}
                        max={300}
                        aria-label={`Delay seconds for ${cmd.name}`}
                        value={row.delay}
                        onChange={(e) => updateRowDraft(cmd, { delay: e.target.value })}
                        className="w-12 bg-transparent font-mono tabular-nums text-xs text-white text-right focus:outline-none"
                      />
                      <span className="text-[11px] text-[#7C759E]">s</span>
                    </div>

                    <div className="flex items-center gap-1.5 bg-[#0A0714] border border-white/[0.08] rounded-lg px-2 py-1">
                      <Trash2 className="w-3 h-3 text-rose-300 shrink-0" />
                      <span className="text-[11px] text-[#9E97C2]">Delete</span>
                      <input
                        type="number"
                        min={0}
                        max={86400}
                        aria-label={`Auto-delete seconds for ${cmd.name}`}
                        value={row.deleteAfter}
                        onChange={(e) => updateRowDraft(cmd, { deleteAfter: e.target.value })}
                        className="w-14 bg-transparent font-mono tabular-nums text-xs text-white text-right focus:outline-none"
                      />
                      <span className="text-[11px] text-[#7C759E]">s</span>
                    </div>

                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={() => void saveCommandTiming(cmd)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                        hasChanges
                          ? 'bg-[#8B5CF6] hover:bg-[#7C3AED] text-white'
                          : 'bg-white/[0.07] hover:bg-white/[0.14] text-[#D5D0ED]'
                      }`}
                    >
                      <Save className="w-3 h-3" />
                      {isSaving ? 'Saving...' : 'Set Time'}
                    </button>

                    {(savedDelay > 0 || savedDel > 0) && (
                      <button
                        type="button"
                        disabled={isSaving}
                        title="Reset Delay & Delete Time to 0"
                        aria-label={`Reset timer for ${cmd.name}`}
                        onClick={() =>
                          void saveCommandTiming(cmd, { delaySeconds: 0, deleteAfterSeconds: 0 })
                        }
                        className="p-1.5 rounded-lg bg-white/[0.05] hover:bg-rose-500/20 text-[#9E97C2] hover:text-rose-200 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void executeCommand(`${prefix}${cmd.name}`)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-[#8B5CF6] text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3 h-3" />
                      Test
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
