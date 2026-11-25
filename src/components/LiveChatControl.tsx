import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Ban,
  Check,
  Copy,
  Link2,
  Lock,
  LogOut,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Unlock,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type {
  ConnectionStatus,
  LiveChatMessageItem,
  LiveChatThreadItem,
  LiveControlOverview,
  LiveControlUserEntry,
  LiveGroupDetailItem,
  LiveSessionState,
} from '../types/bot';

interface LiveChatControlProps {
  adminToken: string;
  onRefreshParent: () => Promise<void>;
}

type UserFilterMode = 'all' | 'active' | 'offline' | 'not_paired';
type ChatFilterMode = 'all' | 'dm' | 'group' | 'admin_groups';
type GroupPaneTab = 'messages' | 'admin';

function formatClockTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDateTimeShort(ts: number | string | undefined): string {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

function statusLabel(state: LiveSessionState): { text: string; className: string } {
  switch (state) {
    case 'active':
      return { text: 'Active Now', className: 'text-emerald-400' };
    case 'connecting':
      return { text: 'Connecting', className: 'text-[#C4B5FD]' };
    case 'offline':
      return { text: 'Offline', className: 'text-amber-300' };
    case 'logged_out':
      return { text: 'Logged Out', className: 'text-rose-400' };
    case 'not_paired':
      return { text: 'Not Paired', className: 'text-[#8B84AD]' };
  }
}

export function LiveChatControl({ adminToken, onRefreshParent }: LiveChatControlProps) {
  const [overview, setOverview] = useState<LiveControlOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [userFilter, setUserFilter] = useState<UserFilterMode>('all');
  const [userSearch, setUserSearch] = useState('');

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionMeta, setSessionMeta] = useState<{
    sessionId: string;
    phone: string;
    name: string;
    status: ConnectionStatus;
    connected: boolean;
  } | null>(null);
  const [chatStats, setChatStats] = useState({
    totalChats: 0,
    dmCount: 0,
    groupCount: 0,
    adminGroupCount: 0,
  });
  const [chats, setChats] = useState<LiveChatThreadItem[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [chatFilter, setChatFilter] = useState<ChatFilterMode>('all');
  const [chatSearch, setChatSearch] = useState('');

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveChatMessageItem[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  const [groupPaneTab, setGroupPaneTab] = useState<GroupPaneTab>('messages');
  const [groupDetail, setGroupDetail] = useState<LiveGroupDetailItem | null>(null);
  const [loadingGroupDetail, setLoadingGroupDetail] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [addMemberPhone, setAddMemberPhone] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [groupInviteUrl, setGroupInviteUrl] = useState<string | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [confirmLeaveGroupId, setConfirmLeaveGroupId] = useState<string | null>(null);
  const [confirmLogoutSessionId, setConfirmLogoutSessionId] = useState<string | null>(null);

  const [showNewDmForm, setShowNewDmForm] = useState(false);
  const [newDmPhone, setNewDmPhone] = useState('');
  const [newDmText, setNewDmText] = useState('');
  const [joinGroupInput, setJoinGroupInput] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const authHeaders = useMemo(
    () => ({ Authorization: `Bearer ${adminToken}` }),
    [adminToken]
  );

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/live-chat/overview', {
        headers: authHeaders,
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as LiveControlOverview & { ok: boolean };
      if (data.ok) {
        setOverview({ counts: data.counts, users: data.users });
        setSelectedSessionId((prev) => {
          if (prev && data.users.some((u) => u.sessionId === prev)) {
            return prev;
          }
          const firstActive = data.users.find((u) => u.liveStatus === 'active' && u.sessionId);
          const firstWithSession = data.users.find((u) => u.sessionId);
          return firstActive?.sessionId || firstWithSession?.sessionId || null;
        });
      }
    } catch {
      // Transient poll error
    } finally {
      setLoadingOverview(false);
    }
  }, [authHeaders]);

  const fetchSessionChats = useCallback(
    async (sid: string, showSpinner = false) => {
      if (!sid) return;
      if (showSpinner) setLoadingChats(true);
      try {
        const res = await fetch(
          `/api/live-chat/sessions/${encodeURIComponent(sid)}/chats`,
          { headers: authHeaders, cache: 'no-store' }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok) {
          setSessionMeta(data.session);
          setChatStats(data.stats);
          setChats(data.chats || []);
        }
      } catch {
        // Ignore transient poll error
      } finally {
        if (showSpinner) setLoadingChats(false);
      }
    },
    [authHeaders]
  );

  const fetchChatMessages = useCallback(
    async (sid: string, cid: string, showSpinner = false) => {
      if (!sid || !cid) return;
      if (showSpinner) setLoadingMessages(true);
      try {
        const res = await fetch(
          `/api/live-chat/sessions/${encodeURIComponent(sid)}/messages?chatId=${encodeURIComponent(
            cid
          )}&limit=100`,
          { headers: authHeaders, cache: 'no-store' }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok) {
          setMessages(data.messages || []);
        }
      } catch {
        // Ignore transient poll error
      } finally {
        if (showSpinner) setLoadingMessages(false);
      }
    },
    [authHeaders]
  );

  const fetchGroupDetail = useCallback(
    async (sid: string, gid: string, showSpinner = true) => {
      if (!sid || !gid || !gid.endsWith('@g.us')) return;
      if (showSpinner) setLoadingGroupDetail(true);
      try {
        const res = await fetch(
          `/api/live-chat/sessions/${encodeURIComponent(sid)}/groups/${encodeURIComponent(gid)}`,
          { headers: authHeaders, cache: 'no-store' }
        );
        const data = await res.json();
        if (res.ok && data.ok && data.group) {
          setGroupDetail(data.group);
          setEditSubject(data.group.subject || '');
          setEditDesc(data.group.desc || '');
        } else if (showSpinner && !data.ok) {
          setGroupDetail(null);
        }
      } catch {
        if (showSpinner) setGroupDetail(null);
      } finally {
        if (showSpinner) setLoadingGroupDetail(false);
      }
    },
    [authHeaders]
  );

  useEffect(() => {
    void fetchOverview();
    const timer = setInterval(() => {
      if (!document.hidden) void fetchOverview();
    }, 2500);
    return () => clearInterval(timer);
  }, [fetchOverview]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionMeta(null);
      setChats([]);
      setSelectedChatId(null);
      return;
    }
    setSelectedChatId(null);
    setMessages([]);
    setGroupDetail(null);
    setGroupInviteUrl(null);
    void fetchSessionChats(selectedSessionId, true);

    const timer = setInterval(() => {
      if (!document.hidden) void fetchSessionChats(selectedSessionId, false);
    }, 5000);
    return () => clearInterval(timer);
  }, [selectedSessionId, fetchSessionChats]);

  useEffect(() => {
    if (!selectedSessionId || !selectedChatId) {
      setMessages([]);
      setGroupDetail(null);
      return;
    }
    void fetchChatMessages(selectedSessionId, selectedChatId, true);
    if (selectedChatId.endsWith('@g.us')) {
      setGroupInviteUrl(null);
      setConfirmLeaveGroupId(null);
      void fetchGroupDetail(selectedSessionId, selectedChatId, true);
    } else {
      setGroupDetail(null);
      setGroupPaneTab('messages');
    }

    const timer = setInterval(() => {
      if (!document.hidden) {
        void fetchChatMessages(selectedSessionId, selectedChatId, false);
      }
    }, 2200);
    return () => clearInterval(timer);
  }, [selectedSessionId, selectedChatId, fetchChatMessages, fetchGroupDetail]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length, selectedChatId]);

  const filteredUsers = useMemo(() => {
    const list = overview?.users || [];
    const q = userSearch.trim().toLowerCase();
    return list.filter((u) => {
      if (userFilter === 'active' && u.liveStatus !== 'active') return false;
      if (
        userFilter === 'offline' &&
        u.liveStatus !== 'offline' &&
        u.liveStatus !== 'logged_out' &&
        u.liveStatus !== 'connecting'
      ) {
        return false;
      }
      if (userFilter === 'not_paired' && u.liveStatus !== 'not_paired') return false;
      if (!q) return true;
      return (
        u.number.includes(q) ||
        u.name.toLowerCase().includes(q) ||
        (u.sessionId || '').toLowerCase().includes(q)
      );
    });
  }, [overview?.users, userFilter, userSearch]);

  const filteredChats = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    return chats.filter((c) => {
      if (chatFilter === 'dm' && c.chatType !== 'dm') return false;
      if (chatFilter === 'group' && c.chatType !== 'group') return false;
      if (chatFilter === 'admin_groups' && !(c.chatType === 'group' && c.isAdmin)) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.chatId.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.lastMessage.toLowerCase().includes(q)
      );
    });
  }, [chats, chatFilter, chatSearch]);

  const selectedChat = useMemo(
    () => chats.find((c) => c.chatId === selectedChatId) || null,
    [chats, selectedChatId]
  );

  const selectedUserEntry = useMemo(
    () => overview?.users.find((u) => u.sessionId === selectedSessionId) || null,
    [overview?.users, selectedSessionId]
  );

  const filteredParticipants = useMemo(() => {
    if (!groupDetail) return [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return groupDetail.participants;
    return groupDetail.participants.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.phone.includes(q) ||
        p.jid.toLowerCase().includes(q) ||
        p.role.includes(q)
    );
  }, [groupDetail, memberSearch]);

  async function handleSessionControl(
    sid: string,
    action: 'reconnect' | 'disconnect' | 'logout' | 'join_group' | 'block' | 'unblock' | 'presence',
    payload?: { inviteCode?: string; target?: string; presence?: 'available' | 'unavailable' }
  ) {
    setBusyAction(`${action}:${sid}`);
    setFeedback(null);
    try {
      const res = await fetch(`/api/live-chat/sessions/${encodeURIComponent(sid)}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Session control action failed.' });
      } else {
        setFeedback({ type: 'ok', text: data.message || 'Action completed.' });
        setConfirmLogoutSessionId(null);
        if (action === 'join_group') {
          setJoinGroupInput('');
        }
        await fetchOverview();
        if (sid === selectedSessionId) {
          await fetchSessionChats(sid, false);
        }
        await onRefreshParent();
      }
    } catch {
      setFeedback({ type: 'err', text: 'Unable to communicate with server.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSendReply(e: FormEvent) {
    e.preventDefault();
    if (!selectedSessionId || !selectedChatId || !replyText.trim()) return;
    setSendingReply(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            target: selectedChatId,
            text: replyText.trim(),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Failed to send message.' });
      } else {
        setReplyText('');
        await fetchChatMessages(selectedSessionId, selectedChatId, false);
        await fetchSessionChats(selectedSessionId, false);
      }
    } catch {
      setFeedback({ type: 'err', text: 'Failed to reach server.' });
    } finally {
      setSendingReply(false);
    }
  }

  async function handleStartNewDm(e: FormEvent) {
    e.preventDefault();
    if (!selectedSessionId || !newDmPhone.trim() || !newDmText.trim()) return;
    setBusyAction('new_dm');
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            target: newDmPhone.trim(),
            text: newDmText.trim(),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Could not send DM.' });
      } else {
        setNewDmPhone('');
        setNewDmText('');
        setShowNewDmForm(false);
        await fetchSessionChats(selectedSessionId, false);
        if (data.chatId) {
          setSelectedChatId(data.chatId);
          setGroupPaneTab('messages');
        }
        setFeedback({ type: 'ok', text: `Message sent to ${data.chatId}.` });
      }
    } catch {
      setFeedback({ type: 'err', text: 'Network error sending DM.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteMessage(msg: LiveChatMessageItem) {
    if (!selectedSessionId || !msg.key) return;
    setBusyAction(`del:${msg.id}`);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/delete-message`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            chatId: msg.chatId,
            msgId: msg.key.id,
            fromMe: msg.key.fromMe,
            participant: msg.key.participant,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Could not delete message.' });
      } else {
        await fetchChatMessages(selectedSessionId, msg.chatId, false);
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleGroupAction(
    action:
      | 'promote'
      | 'demote'
      | 'add'
      | 'remove'
      | 'mute'
      | 'unmute'
      | 'lock'
      | 'unlock'
      | 'subject'
      | 'description'
      | 'invite'
      | 'revoke'
      | 'leave',
    payload?: { targets?: string[]; subject?: string; description?: string }
  ) {
    if (!selectedSessionId || !selectedChatId) return;
    setBusyAction(`grp:${action}:${(payload?.targets || []).join(',')}`);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/groups/${encodeURIComponent(
          selectedChatId
        )}/action`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({ action, ...payload }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Group action failed.' });
      } else {
        if (data.inviteUrl) {
          setGroupInviteUrl(data.inviteUrl);
        }
        if (action === 'add') {
          setAddMemberPhone('');
        }
        if (action === 'leave') {
          setConfirmLeaveGroupId(null);
          setSelectedChatId(null);
          setGroupDetail(null);
          await fetchSessionChats(selectedSessionId, false);
        } else {
          await Promise.all([
            fetchGroupDetail(selectedSessionId, selectedChatId, false),
            fetchSessionChats(selectedSessionId, false),
          ]);
        }
        setFeedback({ type: 'ok', text: data.message || 'Group updated.' });
      }
    } catch {
      setFeedback({ type: 'err', text: 'Failed to execute group action.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopyInvite(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 1600);
  }

  const counts = overview?.counts;

  return (
    <div className="space-y-6">
      {/* Live Pairing & Session Counting Bar */}
      <section className="glass-surface rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <Users className="w-4 h-4 text-[#A78BFA]" />
            <div>
              <h2 className="text-lg font-semibold text-white">
                Live User Counting &amp; WhatsApp Control Center
              </h2>
              <p className="text-xs text-[#9E97C2]">
                Real-time paired vs unpaired counts, live online/offline sessions, full user inbox &amp; group admin control.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void fetchOverview()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[#A78BFA]" />
            Refresh Live Counts
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-4 py-3">
            <div className="text-xs text-[#948DB8]">Paired Users</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-white">
              {counts?.pairedCount ?? 0}
            </div>
            <div className="mt-0.5 text-[11px] text-[#8B84AD]">
              Total linked WhatsApp accounts
            </div>
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-4 py-3">
            <div className="text-xs text-[#948DB8]">Active Now (Online)</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-emerald-400">
              {counts?.activeCount ?? 0}
            </div>
            <div className="mt-0.5 text-[11px] text-[#8B84AD]">
              Live connected WhatsApp sockets
            </div>
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-4 py-3">
            <div className="text-xs text-[#948DB8]">Offline / Inactive</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-amber-300">
              {counts?.inactiveCount ?? 0}
            </div>
            <div className="mt-0.5 text-[11px] text-[#8B84AD]">
              Paired before · not active now
            </div>
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-4 py-3">
            <div className="text-xs text-[#948DB8]">Not Paired Yet</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-[#C4B5FD]">
              {counts?.notPairedCount ?? 0}
            </div>
            <div className="mt-0.5 text-[11px] text-[#8B84AD]">
              Authorized VIPs not yet linked
            </div>
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-4 py-3 col-span-2 sm:col-span-1">
            <div className="text-xs text-[#948DB8]">Total User Pool</div>
            <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-white">
              {counts?.totalUsers ?? 0}
            </div>
            <div className="mt-0.5 text-[11px] text-[#8B84AD]">
              VIPs + open paired sessions
            </div>
          </div>
        </div>
      </section>

      {feedback && (
        <div
          className={`text-xs px-4 py-3 rounded-xl border ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
              : 'bg-rose-500/10 border-rose-500/25 text-rose-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* User Directory (Active / Offline / Not Paired) */}
      <section className="glass-surface rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.07]">
          <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
            {(
              [
                { id: 'all', label: `All (${counts?.totalUsers ?? 0})` },
                { id: 'active', label: `Active (${counts?.activeCount ?? 0})` },
                { id: 'offline', label: `Offline (${counts?.inactiveCount ?? 0})` },
                { id: 'not_paired', label: `Not Paired (${counts?.notPairedCount ?? 0})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setUserFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  userFilter === tab.id
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#A9A2C8] hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search user phone or name..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.08] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
            />
          </div>
        </div>

        {loadingOverview && filteredUsers.length === 0 ? (
          <div className="py-10 text-center text-sm text-[#8B84AD]">
            Loading live user sessions...
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="py-10 text-center text-sm text-[#8B84AD]">
            No users match this filter right now.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-xs text-[#8B84AD] border-b border-white/[0.07]">
                  <th className="py-2.5 pr-4 font-medium">User / Number</th>
                  <th className="py-2.5 pr-4 font-medium">Live Status</th>
                  <th className="py-2.5 pr-4 font-medium">Role / Session</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Chats / Msgs</th>
                  <th className="py-2.5 pr-4 font-medium">Last Active</th>
                  <th className="py-2.5 pl-4 font-medium text-right">Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {filteredUsers.map((u: LiveControlUserEntry) => {
                  const st = statusLabel(u.liveStatus);
                  const isSelected = Boolean(u.sessionId && selectedSessionId === u.sessionId);
                  const isConfirmingLogout = Boolean(
                    u.sessionId && confirmLogoutSessionId === u.sessionId
                  );

                  return (
                    <tr
                      key={`${u.number}:${u.sessionId || 'none'}`}
                      className={`transition-colors ${
                        isSelected ? 'bg-[#8B5CF6]/12' : 'hover:bg-white/[0.02]'
                      }`}
                    >
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-white">{u.name}</div>
                        <div className="font-mono tabular-nums text-[#A9A2C8]">+{u.number}</div>
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 font-semibold ${st.className}`}>
                          {u.online ? (
                            <Wifi className="w-3.5 h-3.5" />
                          ) : (
                            <WifiOff className="w-3.5 h-3.5" />
                          )}
                          <span>{st.text}</span>
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[#C4BFE0] whitespace-nowrap">
                        <span className="capitalize">
                          {u.tier === 'paired' ? 'Paired User' : u.tier}
                        </span>
                        <span aria-hidden="true" className="mx-1.5 text-white/30">·</span>
                        <span className="font-mono text-[#9E97C2]">
                          {u.sessionId || 'No Session'}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums text-white whitespace-nowrap">
                        {u.chatCount} / {u.messageCount}
                      </td>
                      <td className="py-3 pr-4 font-mono tabular-nums text-[#9E97C2] whitespace-nowrap">
                        {formatDateTimeShort(u.lastActivityAt || u.lastPairedAt)}
                      </td>
                      <td className="py-3 pl-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-2">
                          {u.sessionId && (
                            <button
                              type="button"
                              onClick={() => setSelectedSessionId(u.sessionId)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                isSelected
                                  ? 'bg-[#8B5CF6] text-white'
                                  : 'bg-white/[0.08] hover:bg-white/[0.15] text-white'
                              }`}
                            >
                              {isSelected ? 'Opened' : 'Open WhatsApp'}
                            </button>
                          )}

                          {u.sessionId && u.canReconnect && (
                            <button
                              type="button"
                              disabled={busyAction === `reconnect:${u.sessionId}`}
                              onClick={() => void handleSessionControl(u.sessionId!, 'reconnect')}
                              className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-xs font-medium cursor-pointer disabled:opacity-50"
                            >
                              Reconnect
                            </button>
                          )}

                          {u.sessionId && u.online && (
                            <button
                              type="button"
                              disabled={busyAction === `disconnect:${u.sessionId}`}
                              onClick={() => void handleSessionControl(u.sessionId!, 'disconnect')}
                              className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-xs font-medium cursor-pointer disabled:opacity-50"
                            >
                              Pause
                            </button>
                          )}

                          {u.sessionId && u.canDisconnect && (
                            isConfirmingLogout ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busyAction === `logout:${u.sessionId}`}
                                  onClick={() => void handleSessionControl(u.sessionId!, 'logout')}
                                  className="px-2.5 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold cursor-pointer"
                                >
                                  Confirm Unlink
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmLogoutSessionId(null)}
                                  className="px-2 py-1.5 rounded-lg bg-white/[0.08] text-xs text-white cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmLogoutSessionId(u.sessionId!)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 text-xs font-medium cursor-pointer"
                              >
                                <LogOut className="w-3 h-3" />
                                Logout
                              </button>
                            )
                          )}

                          {!u.sessionId && (
                            <span className="text-[#7C759E]">Waiting to Pair</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Selected User WhatsApp Inspector & Full Group Admin Workspace */}
      <section className="glass-surface rounded-2xl overflow-hidden">
        {!selectedSessionId ? (
          <div className="p-12 text-center space-y-2">
            <MessageSquare className="w-8 h-8 text-[#8B5CF6] mx-auto" />
            <div className="text-base font-semibold text-white">
              Select Any Paired User Above
            </div>
            <p className="text-xs text-[#9E97C2] max-w-md mx-auto">
              Click &ldquo;Open WhatsApp&rdquo; on any active or paired user to view every person&apos;s chats, see which groups they admin, promote/demote admins, add/remove members, and send messages live.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.07]">
            {/* Selected User Account Header & Quick WhatsApp Actions */}
            <div className="p-5 flex flex-wrap items-center justify-between gap-4 bg-white/[0.02]">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-base font-bold text-white">
                    {selectedUserEntry?.name || sessionMeta?.name || selectedSessionId}
                  </span>
                  <span aria-hidden="true" className="text-white/30">·</span>
                  <span className="font-mono tabular-nums text-[#C4B5FD]">
                    +{selectedUserEntry?.number || sessionMeta?.phone || 'Unknown'}
                  </span>
                  <span aria-hidden="true" className="text-white/30">·</span>
                  <span
                    className={`font-semibold ${
                      sessionMeta?.connected ? 'text-emerald-400' : 'text-amber-300'
                    }`}
                  >
                    {sessionMeta?.connected ? 'WhatsApp Connected' : `Status: ${sessionMeta?.status || 'offline'}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#9E97C2] tabular-nums">
                  <span>{chatStats.totalChats} Total Chats</span>
                  <span aria-hidden="true">·</span>
                  <span>{chatStats.dmCount} DMs / Inbox</span>
                  <span aria-hidden="true">·</span>
                  <span>{chatStats.groupCount} Groups</span>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-300 font-semibold">
                    {chatStats.adminGroupCount} Groups Where User is Admin
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewDmForm((prev) => !prev)}
                  disabled={!sessionMeta?.connected}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Message New Number
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void handleSessionControl(selectedSessionId, 'presence', {
                      presence: 'available',
                    })
                  }
                  disabled={!sessionMeta?.connected}
                  className="px-3 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                >
                  Set Online
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void handleSessionControl(selectedSessionId, 'presence', {
                      presence: 'unavailable',
                    })
                  }
                  disabled={!sessionMeta?.connected}
                  className="px-3 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                >
                  Set Offline
                </button>
                <button
                  type="button"
                  onClick={() => void fetchSessionChats(selectedSessionId, true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingChats ? 'animate-spin' : ''}`} />
                  Sync Chats
                </button>
              </div>
            </div>

            {/* Quick Bar: New DM + Join Group via Invite */}
            {(showNewDmForm || sessionMeta?.connected) && (
              <div className="px-5 py-3 bg-[#090613]/70 flex flex-wrap items-center gap-4">
                {showNewDmForm && (
                  <form onSubmit={handleStartNewDm} className="flex flex-wrap items-center gap-2 flex-1 min-w-[280px]">
                    <input
                      type="text"
                      value={newDmPhone}
                      onChange={(e) => setNewDmPhone(e.target.value)}
                      placeholder="Phone e.g. 923001234567"
                      required
                      className="w-44 px-3 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.12] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                    />
                    <input
                      type="text"
                      value={newDmText}
                      onChange={(e) => setNewDmText(e.target.value)}
                      placeholder="Type message to send from user's WhatsApp..."
                      required
                      className="flex-1 min-w-[180px] px-3 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.12] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                    />
                    <button
                      type="submit"
                      disabled={busyAction === 'new_dm'}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer disabled:opacity-50"
                    >
                      <Send className="w-3 h-3" />
                      Send DM
                    </button>
                  </form>
                )}

                {sessionMeta?.connected && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!joinGroupInput.trim()) return;
                      void handleSessionControl(selectedSessionId, 'join_group', {
                        inviteCode: joinGroupInput.trim(),
                      });
                    }}
                    className="flex items-center gap-2 ml-auto"
                  >
                    <input
                      type="text"
                      value={joinGroupInput}
                      onChange={(e) => setJoinGroupInput(e.target.value)}
                      placeholder="Join group link (chat.whatsapp.com/...)"
                      className="w-64 px-3 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                    />
                    <button
                      type="submit"
                      disabled={!joinGroupInput.trim() || busyAction === `join_group:${selectedSessionId}`}
                      className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                    >
                      Join Group
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* 2-Column Split: Left = All Chats & Admin Groups, Right = Conversation + Group Admin Control */}
            <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[580px]">
              {/* Left Column: Chats & Groups List */}
              <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-white/[0.07] flex flex-col">
                <div className="p-4 space-y-3 border-b border-white/[0.06]">
                  <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
                    {(
                      [
                        { id: 'all', label: `All (${chats.length})` },
                        { id: 'dm', label: `DMs (${chatStats.dmCount})` },
                        { id: 'group', label: `Groups (${chatStats.groupCount})` },
                        { id: 'admin_groups', label: `Admin (${chatStats.adminGroupCount})` },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setChatFilter(f.id)}
                        className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          chatFilter === f.id
                            ? 'bg-[#8B5CF6] text-white'
                            : 'text-[#A9A2C8] hover:text-white'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={chatSearch}
                      onChange={(e) => setChatSearch(e.target.value)}
                      placeholder="Filter person, number, or group name..."
                      className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.08] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                    />
                  </div>
                </div>

                <div className="flex-1 max-h-[560px] overflow-y-auto divide-y divide-white/[0.05]">
                  {loadingChats && filteredChats.length === 0 ? (
                    <div className="py-12 text-center text-xs text-[#8B84AD]">
                      Fetching live chats &amp; groups from WhatsApp...
                    </div>
                  ) : filteredChats.length === 0 ? (
                    <div className="py-12 px-4 text-center text-xs text-[#8B84AD]">
                      No chats found in this filter. Incoming &amp; outgoing DMs appear live as messages flow, and all groups sync automatically when online.
                    </div>
                  ) : (
                    filteredChats.map((chat) => {
                      const active = selectedChatId === chat.chatId;
                      return (
                        <button
                          key={chat.chatId}
                          type="button"
                          onClick={() => {
                            setSelectedChatId(chat.chatId);
                            if (chat.chatType === 'group' && chat.isAdmin) {
                              setGroupPaneTab('messages');
                            }
                          }}
                          className={`w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                            active ? 'bg-[#8B5CF6]/16' : 'hover:bg-white/[0.03]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-white truncate">
                                {chat.name}
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#9E97C2] mt-0.5">
                                <span>{chat.chatType === 'group' ? 'Group' : 'DM'}</span>
                                {chat.chatType === 'group' && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">
                                      {chat.participantCount ?? 0} members
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    {chat.isSuperAdmin ? (
                                      <span className="text-emerald-400 font-semibold">SuperAdmin</span>
                                    ) : chat.isAdmin ? (
                                      <span className="text-emerald-400 font-semibold">Admin</span>
                                    ) : (
                                      <span className="text-[#8B84AD]">Member</span>
                                    )}
                                  </>
                                )}
                                {chat.chatType === 'dm' && chat.phone && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-mono tabular-nums">+{chat.phone}</span>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              <div className="text-[11px] font-mono tabular-nums text-[#8B84AD]">
                                {formatClockTime(chat.lastTimestamp)}
                              </div>
                              {chat.messageCount > 0 && (
                                <div className="text-[11px] font-mono tabular-nums text-[#C4B5FD] mt-0.5">
                                  {chat.messageCount} msgs
                                </div>
                              )}
                            </div>
                          </div>

                          {chat.lastMessage && (
                            <div className="text-xs text-[#B6AFD4] truncate mt-1.5">
                              {chat.lastSenderName ? `${chat.lastSenderName}: ` : ''}
                              {chat.lastMessage}
                            </div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Opened Chat Thread & Group Admin Control */}
              <div className="lg:col-span-7 flex flex-col">
                {!selectedChat ? (
                  <div className="flex-1 flex flex-col items-center justify-center p-10 text-center space-y-2">
                    <ShieldCheck className="w-8 h-8 text-[#A78BFA]" />
                    <div className="text-sm font-semibold text-white">
                      Open Any Person&apos;s Chat or Admin Group
                    </div>
                    <p className="text-xs text-[#9E97C2] max-w-sm">
                      Select a DM or Group on the left to read messages, reply directly from this user&apos;s WhatsApp, or promote/demote/add/remove group admins.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Chat / Group Header */}
                    <div className="px-5 py-4 border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-3 bg-white/[0.02]">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-bold text-white truncate">
                            {selectedChat.name}
                          </h3>
                          {selectedChat.chatType === 'group' && selectedChat.isAdmin && (
                            <span className="text-xs font-semibold text-emerald-400 shrink-0">
                              · {selectedChat.isSuperAdmin ? 'SuperAdmin' : 'Group Admin'}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-[#8B84AD] truncate">
                          {selectedChat.chatId}
                        </div>
                      </div>

                      {selectedChat.chatType === 'group' ? (
                        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
                          <button
                            type="button"
                            onClick={() => setGroupPaneTab('messages')}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                              groupPaneTab === 'messages'
                                ? 'bg-[#8B5CF6] text-white'
                                : 'text-[#A9A2C8] hover:text-white'
                            }`}
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            Chat ({messages.length})
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setGroupPaneTab('admin');
                              void fetchGroupDetail(selectedSessionId, selectedChat.chatId, true);
                            }}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                              groupPaneTab === 'admin'
                                ? 'bg-[#8B5CF6] text-white'
                                : 'text-[#A9A2C8] hover:text-white'
                            }`}
                          >
                            <Shield className="w-3.5 h-3.5" />
                            Group Admin Control
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              void handleSessionControl(selectedSessionId, 'block', {
                                target: selectedChat.chatId,
                              })
                            }
                            disabled={!sessionMeta?.connected}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-xs font-medium text-rose-200 cursor-pointer disabled:opacity-45"
                          >
                            <Ban className="w-3.5 h-3.5" />
                            Block
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleSessionControl(selectedSessionId, 'unblock', {
                                target: selectedChat.chatId,
                              })
                            }
                            disabled={!sessionMeta?.connected}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-xs font-medium text-emerald-200 cursor-pointer disabled:opacity-45"
                          >
                            Unblock
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Pane Content: Messages vs Group Admin Control */}
                    {selectedChat.chatType === 'group' && groupPaneTab === 'admin' ? (
                      <div className="flex-1 p-5 space-y-5 max-h-[560px] overflow-y-auto">
                        {loadingGroupDetail && !groupDetail ? (
                          <div className="py-12 text-center text-xs text-[#8B84AD]">
                            Loading live group participants &amp; admin list...
                          </div>
                        ) : !groupDetail ? (
                          <div className="py-12 text-center space-y-3">
                            <div className="text-xs text-[#9E97C2]">
                              Connect this user&apos;s WhatsApp session to inspect and control group admins &amp; members live.
                            </div>
                          </div>
                        ) : (
                          <>
                            {/* Admin Status & Quick Group Controls */}
                            <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4 space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-xs">
                                  <span className="font-semibold text-white">Your Role: </span>
                                  {groupDetail.isBotSuperAdmin ? (
                                    <span className="text-emerald-400 font-semibold">
                                      SuperAdmin (Full Control)
                                    </span>
                                  ) : groupDetail.isBotAdmin ? (
                                    <span className="text-emerald-400 font-semibold">
                                      Group Admin (Full Promote/Demote/Add/Kick Control)
                                    </span>
                                  ) : (
                                    <span className="text-amber-300 font-semibold">
                                      Regular Member (Not Admin — Admin actions restricted by WhatsApp)
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs font-mono tabular-nums text-[#C4BFE0]">
                                  {groupDetail.participantCount} members · {groupDetail.adminCount} admins
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  disabled={!groupDetail.isBotAdmin || Boolean(busyAction)}
                                  onClick={() =>
                                    void handleGroupAction(groupDetail.announce ? 'unmute' : 'mute')
                                  }
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white cursor-pointer disabled:opacity-45"
                                >
                                  {groupDetail.announce ? (
                                    <>
                                      <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                                      Open Chat (Everyone)
                                    </>
                                  ) : (
                                    <>
                                      <VolumeX className="w-3.5 h-3.5 text-amber-300" />
                                      Mute Group (Admins Only)
                                    </>
                                  )}
                                </button>

                                <button
                                  type="button"
                                  disabled={!groupDetail.isBotAdmin || Boolean(busyAction)}
                                  onClick={() =>
                                    void handleGroupAction(groupDetail.restrict ? 'unlock' : 'lock')
                                  }
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white cursor-pointer disabled:opacity-45"
                                >
                                  {groupDetail.restrict ? (
                                    <>
                                      <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                                      Unlock Info
                                    </>
                                  ) : (
                                    <>
                                      <Lock className="w-3.5 h-3.5 text-amber-300" />
                                      Lock Info
                                    </>
                                  )}
                                </button>

                                <button
                                  type="button"
                                  disabled={!groupDetail.isBotAdmin || Boolean(busyAction)}
                                  onClick={() => void handleGroupAction('invite')}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white cursor-pointer disabled:opacity-45"
                                >
                                  <Link2 className="w-3.5 h-3.5 text-[#A78BFA]" />
                                  Get Invite Link
                                </button>

                                <button
                                  type="button"
                                  disabled={!groupDetail.isBotAdmin || Boolean(busyAction)}
                                  onClick={() => void handleGroupAction('revoke')}
                                  className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-medium text-white cursor-pointer disabled:opacity-45"
                                >
                                  Reset Link
                                </button>

                                {confirmLeaveGroupId === groupDetail.id ? (
                                  <div className="inline-flex items-center gap-1 ml-auto">
                                    <button
                                      type="button"
                                      onClick={() => void handleGroupAction('leave')}
                                      className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold cursor-pointer"
                                    >
                                      Confirm Leave
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmLeaveGroupId(null)}
                                      className="px-2.5 py-1.5 rounded-lg bg-white/[0.08] text-xs text-white cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmLeaveGroupId(groupDetail.id)}
                                    className="ml-auto px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-xs font-medium text-rose-200 cursor-pointer"
                                  >
                                    Leave Group
                                  </button>
                                )}
                              </div>

                              {groupInviteUrl && (
                                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#0A0714] border border-white/[0.1] text-xs">
                                  <span className="font-mono text-[#DDD6FE] truncate">
                                    {groupInviteUrl}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyInvite(groupInviteUrl)}
                                    className="inline-flex items-center gap-1 text-xs font-semibold text-white shrink-0 cursor-pointer"
                                  >
                                    {copiedInvite ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                    {copiedInvite ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                              )}
                            </div>

                            {/* Edit Subject / Description */}
                            {groupDetail.isBotAdmin && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    void handleGroupAction('subject', { subject: editSubject });
                                  }}
                                  className="flex gap-2"
                                >
                                  <input
                                    type="text"
                                    value={editSubject}
                                    onChange={(e) => setEditSubject(e.target.value)}
                                    placeholder="Group Name / Subject"
                                    className="flex-1 px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                                  />
                                  <button
                                    type="submit"
                                    className="px-3 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    Rename
                                  </button>
                                </form>

                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    void handleGroupAction('description', { description: editDesc });
                                  }}
                                  className="flex gap-2"
                                >
                                  <input
                                    type="text"
                                    value={editDesc}
                                    onChange={(e) => setEditDesc(e.target.value)}
                                    placeholder="Group Description"
                                    className="flex-1 px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                                  />
                                  <button
                                    type="submit"
                                    className="px-3 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    Save Desc
                                  </button>
                                </form>
                              </div>
                            )}

                            {/* Add Member to Group */}
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                const targets = addMemberPhone
                                  .split(/[\s,]+/)
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                                if (targets.length === 0) return;
                                void handleGroupAction('add', { targets });
                              }}
                              className="flex flex-wrap items-center gap-2"
                            >
                              <input
                                type="text"
                                value={addMemberPhone}
                                onChange={(e) => setAddMemberPhone(e.target.value)}
                                placeholder="Add member phone(s): 923001234567, 923111234567"
                                disabled={!groupDetail.isBotAdmin}
                                className="flex-1 min-w-[220px] px-3.5 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6] disabled:opacity-50"
                              />
                              <button
                                type="submit"
                                disabled={!groupDetail.isBotAdmin || !addMemberPhone.trim() || Boolean(busyAction)}
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                              >
                                <UserPlus className="w-3.5 h-3.5" />
                                Add Member
                              </button>
                            </form>

                            {/* Participants & Promote/Demote Admin Controls */}
                            <div className="space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className="text-xs font-semibold text-white">
                                  Members &amp; Admins ({filteredParticipants.length})
                                </h4>
                                <div className="relative w-60">
                                  <Search className="w-3.5 h-3.5 text-[#7C759E] absolute left-2.5 top-1/2 -translate-y-1/2" />
                                  <input
                                    type="text"
                                    value={memberSearch}
                                    onChange={(e) => setMemberSearch(e.target.value)}
                                    placeholder="Search member name or phone..."
                                    className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.08] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                                  />
                                </div>
                              </div>

                              <div className="divide-y divide-white/[0.06] border border-white/[0.07] rounded-xl overflow-hidden">
                                {filteredParticipants.map((p) => (
                                  <div
                                    key={p.jid}
                                    className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 hover:bg-white/[0.02]"
                                  >
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 text-xs">
                                        <span className="font-semibold text-white truncate">
                                          {p.name}
                                        </span>
                                        {p.isSelf && (
                                          <span className="text-[#C4B5FD] font-medium">(You)</span>
                                        )}
                                        <span aria-hidden="true" className="text-white/25">·</span>
                                        <span
                                          className={
                                            p.role === 'superadmin'
                                              ? 'text-emerald-400 font-semibold'
                                              : p.role === 'admin'
                                                ? 'text-[#A78BFA] font-semibold'
                                                : 'text-[#8B84AD]'
                                          }
                                        >
                                          {p.role === 'superadmin'
                                            ? 'SuperAdmin'
                                            : p.role === 'admin'
                                              ? 'Admin'
                                              : 'Member'}
                                        </span>
                                      </div>
                                      <div className="text-[11px] font-mono tabular-nums text-[#8B84AD]">
                                        {p.phone ? `+${p.phone}` : p.jid}
                                      </div>
                                    </div>

                                    {!p.isSelf && groupDetail.isBotAdmin && p.role !== 'superadmin' && (
                                      <div className="flex items-center gap-1.5 shrink-0">
                                        {p.role === 'member' ? (
                                          <button
                                            type="button"
                                            disabled={Boolean(busyAction)}
                                            onClick={() =>
                                              void handleGroupAction('promote', { targets: [p.jid] })
                                            }
                                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[11px] font-semibold cursor-pointer disabled:opacity-45"
                                          >
                                            <ShieldCheck className="w-3 h-3" />
                                            Make Admin
                                          </button>
                                        ) : (
                                          <button
                                            type="button"
                                            disabled={Boolean(busyAction)}
                                            onClick={() =>
                                              void handleGroupAction('demote', { targets: [p.jid] })
                                            }
                                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] font-semibold cursor-pointer disabled:opacity-45"
                                          >
                                            <ShieldOff className="w-3 h-3" />
                                            Remove Admin
                                          </button>
                                        )}

                                        <button
                                          type="button"
                                          disabled={Boolean(busyAction)}
                                          onClick={() =>
                                            void handleGroupAction('remove', { targets: [p.jid] })
                                          }
                                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 text-[11px] font-semibold cursor-pointer disabled:opacity-45"
                                        >
                                          <UserMinus className="w-3 h-3" />
                                          Kick
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* Live Message Stream */}
                        <div className="flex-1 p-5 space-y-3 max-h-[460px] overflow-y-auto bg-[#07050F]/45">
                          {loadingMessages && messages.length === 0 ? (
                            <div className="py-12 text-center text-xs text-[#8B84AD]">
                              Loading conversation...
                            </div>
                          ) : messages.length === 0 ? (
                            <div className="py-12 text-center space-y-1.5">
                              <div className="text-xs font-medium text-[#C4BFE0]">
                                No messages captured in this chat yet.
                              </div>
                              <p className="text-[11px] text-[#8B84AD] max-w-sm mx-auto">
                                Any new incoming or outgoing messages in this WhatsApp chat will appear here live, or you can send a message below right now.
                              </p>
                            </div>
                          ) : (
                            messages.map((m) => (
                              <div
                                key={`${m.id}:${m.timestamp}`}
                                className={`flex flex-col ${
                                  m.fromMe ? 'items-end' : 'items-start'
                                }`}
                              >
                                <div
                                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 border text-xs space-y-1 ${
                                    m.fromMe
                                      ? 'bg-[#6D28D9]/25 border-[#A78BFA]/30 text-white'
                                      : 'bg-white/[0.05] border-white/[0.08] text-[#EDE9FE]'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-3 text-[11px]">
                                    <span className="font-semibold text-[#C4B5FD]">
                                      {m.fromMe ? 'You (Bot/User)' : m.senderName}
                                      {!m.fromMe && m.senderNumber ? ` · +${m.senderNumber}` : ''}
                                    </span>
                                    <div className="flex items-center gap-2 shrink-0">
                                      <span className="font-mono tabular-nums text-[#8B84AD]">
                                        {formatClockTime(m.timestamp)}
                                      </span>
                                      {m.key && sessionMeta?.connected && (
                                        <button
                                          type="button"
                                          title="Delete message from WhatsApp"
                                          onClick={() => void handleDeleteMessage(m)}
                                          className="text-[#8B84AD] hover:text-rose-400 cursor-pointer"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                                    {m.text}
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                          <div ref={messagesEndRef} />
                        </div>

                        {/* Live Reply Composer */}
                        <form
                          onSubmit={handleSendReply}
                          className="p-4 border-t border-white/[0.07] bg-white/[0.02] flex items-center gap-2.5"
                        >
                          <input
                            type="text"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            disabled={!sessionMeta?.connected || sendingReply}
                            placeholder={
                              sessionMeta?.connected
                                ? `Reply as +${selectedUserEntry?.number || sessionMeta.phone} into ${selectedChat.name}...`
                                : 'User WhatsApp session is offline — reconnect to send messages'
                            }
                            className="flex-1 px-4 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6] disabled:opacity-50"
                          />
                          <button
                            type="submit"
                            disabled={!sessionMeta?.connected || !replyText.trim() || sendingReply}
                            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                          >
                            <Send className="w-3.5 h-3.5" />
                            {sendingReply ? 'Sending...' : 'Send'}
                          </button>
                        </form>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
