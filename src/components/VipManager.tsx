import { useState, type FormEvent } from 'react';
import { Check, Copy, Plus, Search, ShieldOff, Trash2, UserCheck } from 'lucide-react';
import type { VipTier, VipUser } from '../types/bot';

interface VipManagerProps {
  vips: VipUser[];
  blockedKeys: Array<{ key: string; retryAfterSeconds: number; attempts: number }>;
  adminToken: string;
  onRefresh: () => Promise<void>;
}

export function VipManager({ vips, blockedKeys, adminToken, onRefresh }: VipManagerProps) {
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [tier, setTier] = useState<VipTier>('diamond');
  const [filterTier, setFilterTier] = useState<'all' | VipTier>('all');
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  async function handleAddVip(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/vips', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ number, name, tier }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Could not add VIP user.' });
      } else {
        setFeedback({
          type: 'ok',
          text: `Authorized +${data.vip.number} (${data.vip.tier.toUpperCase()}) with token ${data.vip.token}`,
        });
        setNumber('');
        setName('');
        await onRefresh();
      }
    } catch {
      setFeedback({ type: 'err', text: 'Failed to communicate with server.' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemoveVip(targetNumber: string) {
    setFeedback(null);
    const res = await fetch(`/api/vips/${encodeURIComponent(targetNumber)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setFeedback({ type: 'err', text: data.error || 'Cannot remove user.' });
    } else {
      await onRefresh();
    }
  }

  async function handleUnblock(key: string) {
    await fetch('/api/bot/reset-ratelimit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ key }),
    });
    await onRefresh();
  }

  async function handleCopyToken(token: string) {
    await navigator.clipboard.writeText(token);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 1600);
  }

  const filtered = vips.filter((v) => {
    const matchesTier = filterTier === 'all' || v.tier === filterTier;
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      v.number.includes(q) ||
      v.name.toLowerCase().includes(q) ||
      v.token.toLowerCase().includes(q);
    return matchesTier && matchesSearch;
  });

  return (
    <div className="space-y-8">
      {/* Add VIP Form */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.07]">
          <div>
            <h2 className="text-lg font-semibold text-white">Authorize VIP Access</h2>
            <p className="text-xs text-[#9E97C2] mt-0.5">
              Whitelisted numbers and their generated FKMD tokens can generate 8-digit pairing codes.
            </p>
          </div>
        </div>

        <form onSubmit={handleAddVip} className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-4">
            <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
              Phone Number
            </label>
            <input
              type="text"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="923001234567"
              required
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm font-mono tabular-nums text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
          </div>

          <div className="md:col-span-4">
            <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
              Member Label
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Hamza VIP"
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-[#C4BFE0] mb-1.5">
              Tier
            </label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as VipTier)}
              className="w-full px-3 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-sm text-white focus:outline-none focus:border-[#8B5CF6]"
            >
              <option value="diamond">Diamond VIP</option>
              <option value="gold">Gold VIP</option>
              <option value="owner">Owner</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              Add VIP
            </button>
          </div>
        </form>

        {feedback && (
          <div
            className={`mt-4 text-xs px-3.5 py-2.5 rounded-xl border ${
              feedback.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
                : 'bg-rose-500/10 border-rose-500/25 text-rose-200'
            }`}
          >
            {feedback.text}
          </div>
        )}
      </section>

      {/* VIP Registry Table */}
      <section className="glass-surface rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-white/[0.07]">
          <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
            {(['all', 'owner', 'diamond', 'gold'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFilterTier(t)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filterTier === t
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#A9A2C8] hover:text-white'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search number, name, token..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.08] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
          </div>
        </div>

        <div className="overflow-x-auto mt-3">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-xs text-[#8B84AD] border-b border-white/[0.07]">
                <th className="py-3 pr-4 font-medium">Number</th>
                <th className="py-3 pr-4 font-medium">Member</th>
                <th className="py-3 pr-4 font-medium">Tier</th>
                <th className="py-3 pr-4 font-medium">VIP Token</th>
                <th className="py-3 pr-4 font-medium text-right">Pairings</th>
                <th className="py-3 pl-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-[#8B84AD]">
                    No VIP entries match your filter.
                  </td>
                </tr>
              ) : (
                filtered.map((vip) => (
                  <tr key={vip.number} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 pr-4 font-mono tabular-nums text-white whitespace-nowrap">
                      +{vip.number}
                    </td>
                    <td className="py-3 pr-4 text-[#D5D0ED]">
                      <div className="flex items-center gap-2">
                        <UserCheck className="w-3.5 h-3.5 text-[#A78BFA] shrink-0" />
                        <span>{vip.name}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-xs capitalize text-[#C4BFE0]">
                      {vip.tier}
                    </td>
                    <td className="py-3 pr-4">
                      <button
                        type="button"
                        onClick={() => handleCopyToken(vip.token)}
                        className="inline-flex items-center gap-1.5 font-mono text-xs text-[#C4B5FD] hover:text-white cursor-pointer"
                      >
                        <span>{vip.token}</span>
                        {copiedToken === vip.token ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3 opacity-60" />
                        )}
                      </button>
                    </td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-right text-white">
                      {vip.pairingCount}
                    </td>
                    <td className="py-3 pl-4 text-right">
                      {vip.tier !== 'owner' ? (
                        <button
                          type="button"
                          onClick={() => handleRemoveVip(vip.number)}
                          aria-label={`Remove ${vip.number}`}
                          className="inline-flex items-center gap-1 text-xs text-rose-300 hover:text-rose-200 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Remove
                        </button>
                      ) : (
                        <span className="text-xs text-[#7C759E]">Protected</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Active Rate Limit Blocks */}
      {blockedKeys.length > 0 && (
        <section className="glass-surface rounded-2xl p-6">
          <h3 className="text-base font-semibold text-white pb-3 border-b border-white/[0.07]">
            Active Rate-Limit Blocks
          </h3>
          <div className="divide-y divide-white/[0.06] mt-2">
            {blockedKeys.map((b) => (
              <div key={b.key} className="py-3 flex items-center justify-between gap-4 text-sm">
                <div>
                  <span className="font-mono text-white">{b.key}</span>
                  <span className="text-xs text-amber-300 ml-3 font-mono tabular-nums">
                    {b.retryAfterSeconds}s remaining
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleUnblock(b.key)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs text-white cursor-pointer"
                >
                  <ShieldOff className="w-3.5 h-3.5" />
                  Clear Block
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
