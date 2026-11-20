import { useState, type FormEvent } from 'react';
import { Play, Search, Terminal } from 'lucide-react';
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

export function CommandCenter({ commands, prefix, adminToken, onRefresh }: CommandCenterProps) {
  const [activeCategory, setActiveCategory] = useState<'all' | CommandCategory>('all');
  const [search, setSearch] = useState('');
  const [consoleInput, setConsoleInput] = useState(`${prefix}menu`);
  const [consoleOutput, setConsoleOutput] = useState<string>(
    `Click "Run" on any command or enter "${prefix}menu" below to execute against the modular command handler.`
  );
  const [running, setRunning] = useState(false);

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

      {/* Modular Command Directory */}
      <section className="glass-surface rounded-2xl p-6">
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

        <div className="divide-y divide-white/[0.06] mt-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-[#8B84AD]">
              No commands match your search.
            </div>
          ) : (
            filtered.map((cmd) => (
              <div
                key={cmd.name}
                className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
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
                  </div>
                  <p className="text-xs text-[#B6AFD4]">{cmd.description}</p>
                  <div className="text-[11px] font-mono text-[#7C759E]">
                    Usage: {prefix}
                    {cmd.usage}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void executeCommand(`${prefix}${cmd.name}`)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-[#8B5CF6] text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-center"
                >
                  <Play className="w-3 h-3" />
                  Test
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
