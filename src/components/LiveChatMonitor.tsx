import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  FileText,
  Image as ImageIcon,
  MapPin,
  MessageSquare,
  Mic,
  Phone,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Smile,
  User,
  Users,
  Video,
} from 'lucide-react';
import type {
  MonitorMediaType,
  MonitorSessionEntry,
  SessionChatSummary,
  SessionLiveMessage,
} from '../types/bot';

interface LiveChatMonitorProps {
  adminToken: string;
}

type SessionFilter = 'all' | 'online' | 'paid';
type ChatListFilter = 'all' | 'groups' | 'dms';

function formatClockTime(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatShortTime(ts: number): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function renderMediaIcon(mediaType: MonitorMediaType) {
  switch (mediaType) {
    case 'image':
      return <ImageIcon className="w-3.5 h-3.5 text-sky-300 shrink-0" />;
    case 'video':
      return <Video className="w-3.5 h-3.5 text-purple-300 shrink-0" />;
    case 'audio':
      return <Mic className="w-3.5 h-3.5 text-emerald-300 shrink-0" />;
    case 'sticker':
      return <Smile className="w-3.5 h-3.5 text-amber-300 shrink-0" />;
    case 'document':
      return <FileText className="w-3.5 h-3.5 text-indigo-300 shrink-0" />;
    case 'location':
      return <MapPin className="w-3.5 h-3.5 text-rose-300 shrink-0" />;
    case 'contact':
      return <Phone className="w-3.5 h-3.5 text-teal-300 shrink-0" />;
    default:
      return null;
  }
}

function statusDotClass(status: MonitorSessionEntry['status']): string {
  if (status === 'connected') return 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.75)]';
  if (status === 'connecting' || status === 'pairing_ready' || status === 'qr_ready') {
    return 'bg-amber-400 animate-pulse';
  }
  if (status === 'logged_out') return 'bg-rose-400';
  return 'bg-slate-500';
}

function statusLabel(status: MonitorSessionEntry['status']): string {
  switch (status) {
    case 'connected':
      return 'Online';
    case 'connecting':
      return 'Connecting';
    case 'pairing_ready':
    case 'qr_ready':
      return 'Pairing';
    case 'logged_out':
      return 'Unlinked';
    case 'not_paired':
      return 'Not Paired';
    default:
      return 'Offline';
  }
}

function tierLabel(entry: MonitorSessionEntry): string {
  if (entry.isMain) return 'MAIN BOT';
  if (entry.tier === 'diamond') return 'PAID · DIAMOND';
  if (entry.tier === 'gold') return 'PAID · GOLD';
  if (entry.tier === 'owner') return 'OWNER';
  return 'PAIRED';
}

export function LiveChatMonitor({ adminToken }: LiveChatMonitorProps) {
  const [sessions, setSessions] = useState<MonitorSessionEntry[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [sessionSearch, setSessionSearch] = useState('');

  const [chats, setChats] = useState<SessionChatSummary[]>([]);
  const [groupsCount, setGroupsCount] = useState(0);
  const [dmsCount, setDmsCount] = useState(0);
  const [chatFilter, setChatFilter] = useState<ChatListFilter>('all');
  const [chatSearch, setChatSearch] = useState('');

  // '' means Unified Live Feed across all groups & DMs of the selected user
  const [selectedChatId, setSelectedChatId] = useState<string>('');
  const [messages, setMessages] = useState<SessionLiveMessage[]>([]);

  const [syncingGroups, setSyncingGroups] = useState(false);
  const [autoLive, setAutoLive] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastMsgSignatureRef = useRef<string>('');

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions/monitor', {
        headers: { Authorization: `Bearer ${adminToken}` },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && Array.isArray(data.sessions)) {
        const list = data.sessions as MonitorSessionEntry[];
        setSessions(list);
        setSelectedSessionId((prev) => {
          if (prev && list.some((s) => s.sessionId === prev)) return prev;
          return list[0]?.sessionId || '';
        });
      }
    } catch {
      // Transient polling error
    } finally {
      setLoadingSessions(false);
    }
  }, [adminToken]);

  const fetchSessionChats = useCallback(
    async (sessionId: string, forceRefresh = false) => {
      if (!sessionId) {
        setChats([]);
        setGroupsCount(0);
        setDmsCount(0);
        return;
      }
      if (forceRefresh) setSyncingGroups(true);
      try {
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/chats${
          forceRefresh ? '?refresh=1' : ''
        }`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${adminToken}` },
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok) {
          setChats(Array.isArray(data.all) ? data.all : []);
          setGroupsCount(Array.isArray(data.groups) ? data.groups.length : 0);
          setDmsCount(Array.isArray(data.dms) ? data.dms.length : 0);
          if (!selectedChatId && Array.isArray(data.liveFeed)) {
            setMessages(data.liveFeed);
          }
        }
      } catch {
        // Ignore transient failure
      } finally {
        if (forceRefresh) setSyncingGroups(false);
      }
    },
    [adminToken, selectedChatId]
  );

  const fetchMessages = useCallback(
    async (sessionId: string, chatId: string) => {
      if (!sessionId) {
        setMessages([]);
        return;
      }
      try {
        const qs = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs}`,
          {
            headers: { Authorization: `Bearer ${adminToken}` },
            cache: 'no-store',
          }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok && Array.isArray(data.messages)) {
          setMessages(data.messages);
        }
      } catch {
        // Ignore transient failure
      }
    },
    [adminToken]
  );

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setSelectedChatId('');
    void fetchSessionChats(selectedSessionId, true);
    void fetchMessages(selectedSessionId, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void fetchMessages(selectedSessionId, selectedChatId);
  }, [selectedSessionId, selectedChatId, fetchMessages]);

  useEffect(() => {
    if (!autoLive) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void fetchSessions();
      if (selectedSessionId) {
        void fetchSessionChats(selectedSessionId, false);
        void fetchMessages(selectedSessionId, selectedChatId);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [autoLive, selectedSessionId, selectedChatId, fetchSessions, fetchSessionChats, fetchMessages]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    const sig = `${selectedSessionId}:${selectedChatId}:${messages.length}:${last?.id || ''}`;
    if (autoScroll && sig !== lastMsgSignatureRef.current) {
      lastMsgSignatureRef.current = sig;
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, autoScroll, selectedSessionId, selectedChatId]);

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    return sessions.filter((s) => {
      if (sessionFilter === 'online' && s.status !== 'connected') return false;
      if (sessionFilter === 'paid' && !s.isPaidVip) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.phone.includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        s.tier.toLowerCase().includes(q)
      );
    });
  }, [sessions, sessionFilter, sessionSearch]);

  const filteredChats = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    return chats.filter((c) => {
      if (chatFilter === 'groups' && !c.isGroup) return false;
      if (chatFilter === 'dms' && c.isGroup) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        c.chatId.toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q)
      );
    });
  }, [chats, chatFilter, chatSearch]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  const activeChat = useMemo(
    () => (selectedChatId ? chats.find((c) => c.chatId === selectedChatId) || null : null),
    [chats, selectedChatId]
  );

  const onlineCount = useMemo(
    () => sessions.filter((s) => s.status === 'connected').length,
    [sessions]
  );
  const paidCount = useMemo(() => sessions.filter((s) => s.isPaidVip).length, [sessions]);

  return (
    <div className="space-y-5">
      {/* Header Bar */}
      <div className="glass-surface rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <Radio className="w-5 h-5 text-[#A78BFA]" />
            <h1 className="text-lg font-semibold text-white">
              Paired Numbers &amp; Live Chatting Monitor
            </h1>
          </div>
          <p className="text-xs text-[#9E97C2]">
            View every paired number (Main &amp; Paid/VIP), inspect which WhatsApp groups they are sitting in, see who they are chatting with, and watch live incoming &amp; outgoing messages.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-[#D5D0ED] font-mono tabular-nums">
            Paired: <span className="text-white font-semibold">{sessions.length}</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300 font-mono tabular-nums">
            Online: <span className="font-semibold">{onlineCount}</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-[#8B5CF6]/15 border border-[#8B5CF6]/30 text-xs text-[#DDD6FE] font-mono tabular-nums">
            Paid/VIP: <span className="font-semibold">{paidCount}</span>
          </div>

          <button
            type="button"
            onClick={() => setAutoLive((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors cursor-pointer ${
              autoLive
                ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
                : 'bg-white/[0.05] border-white/[0.1] text-[#A9A2C8]'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{autoLive ? 'Live Stream On' : 'Paused'}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              void fetchSessions();
              if (selectedSessionId) {
                void fetchSessionChats(selectedSessionId, true);
                void fetchMessages(selectedSessionId, selectedChatId);
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#8B5CF6]/20 hover:bg-[#8B5CF6]/30 border border-[#A78BFA]/35 text-xs font-semibold text-white transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncingGroups ? 'animate-spin' : ''}`} />
            <span>Refresh All</span>
          </button>
        </div>
      </div>

      {/* 3-Column Monitor Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* Column 1: All Paired Numbers */}
        <section className="lg:col-span-3 glass-surface rounded-2xl flex flex-col h-[560px] lg:h-[680px] overflow-hidden">
          <div className="p-3.5 border-b border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#C4B5FD]">
                Paired Numbers
              </span>
              <span className="text-[11px] font-mono tabular-nums text-[#8B84AD]">
                {filteredSessions.length}
              </span>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
                placeholder="Search number or name..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'online', label: 'Online' },
                  { id: 'paid', label: 'Paid/VIP' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSessionFilter(tab.id)}
                  className={`py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                    sessionFilter === tab.id
                      ? 'bg-[#8B5CF6] text-white'
                      : 'bg-white/[0.04] text-[#9E97C2] hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05]">
            {loadingSessions ? (
              <div className="p-6 text-center text-xs text-[#8B84AD]">
                Loading paired sessions...
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#8B84AD]">
                No paired numbers match this filter yet.
              </div>
            ) : (
              filteredSessions.map((session) => {
                const isSelected = session.sessionId === selectedSessionId;
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => setSelectedSessionId(session.sessionId)}
                    className={`w-full text-left p-3.5 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#8B5CF6]/18 border-l-2 border-[#A78BFA]'
                        : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(session.status)}`}
                          />
                          <span className="text-xs font-semibold text-white truncate">
                            {session.name}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-[#B6AFD4] mt-0.5 pl-4">
                          {session.phone ? `+${session.phone}` : session.sessionId}
                        </div>
                      </div>

                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${
                          session.status === 'connected'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : session.status === 'logged_out'
                              ? 'bg-rose-500/15 text-rose-300'
                              : 'bg-white/[0.06] text-[#9E97C2]'
                        }`}
                      >
                        {statusLabel(session.status)}
                      </span>
                    </div>

                    <div className="mt-2 pl-4 flex items-center justify-between gap-2 text-[10px]">
                      <span
                        className={`font-semibold tracking-wide ${
                          session.isMain
                            ? 'text-sky-300'
                            : session.isPaidVip
                              ? 'text-[#C4B5FD]'
                              : 'text-[#8B84AD]'
                        }`}
                      >
                        {tierLabel(session)}
                      </span>
                      <span className="text-[#8B84AD] font-mono tabular-nums">
                        {session.totalGroups}G · {session.totalDms}DM · {session.totalMessages}m
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Column 2: Joined Groups & Private DM Chats */}
        <section className="lg:col-span-4 glass-surface rounded-2xl flex flex-col h-[560px] lg:h-[680px] overflow-hidden">
          <div className="p-3.5 border-b border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#C4B5FD] block">
                  Groups &amp; Private Chats
                </span>
                <span className="text-[11px] text-[#9E97C2] truncate block">
                  {activeSession
                    ? `${activeSession.name} (${activeSession.phone ? `+${activeSession.phone}` : activeSession.sessionId})`
                    : 'Select a paired user'}
                </span>
              </div>

              {activeSession && (
                <button
                  type="button"
                  disabled={syncingGroups || activeSession.status !== 'connected'}
                  onClick={() => void fetchSessionChats(activeSession.sessionId, true)}
                  title="Fetch live list of all joined WhatsApp groups"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-[11px] font-medium text-white cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw className={`w-3 h-3 ${syncingGroups ? 'animate-spin' : ''}`} />
                  <span>Sync Groups</span>
                </button>
              )}
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search group name or contact..."
                className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  { id: 'all', label: `All (${chats.length})` },
                  { id: 'groups', label: `Groups (${groupsCount})` },
                  { id: 'dms', label: `Private (${dmsCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setChatFilter(tab.id)}
                  className={`py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                    chatFilter === tab.id
                      ? 'bg-[#8B5CF6] text-white'
                      : 'bg-white/[0.04] text-[#9E97C2] hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05]">
            {activeSession && (
              <button
                type="button"
                onClick={() => setSelectedChatId('')}
                className={`w-full text-left p-3.5 flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                  selectedChatId === ''
                    ? 'bg-emerald-500/15 border-l-2 border-emerald-400'
                    : 'hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
                    <Radio className="w-4 h-4 text-emerald-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white">
                      All Live Chatting (Stream)
                    </div>
                    <div className="text-[11px] text-emerald-300/80 truncate">
                      Watch every incoming &amp; outgoing group + DM live
                    </div>
                  </div>
                </div>
              </button>
            )}

            {!activeSession ? (
              <div className="p-6 text-center text-xs text-[#8B84AD]">
                Choose a paired user on the left to inspect their groups and chats.
              </div>
            ) : filteredChats.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#8B84AD] space-y-2">
                <p>No groups or private chats captured yet for this number.</p>
                {activeSession.status === 'connected' && (
                  <p className="text-[11px] text-[#7C759E]">
                    Click &ldquo;Sync Groups&rdquo; above to load all WhatsApp groups they are sitting in. New chats appear automatically as messages arrive or are sent.
                  </p>
                )}
              </div>
            ) : (
              filteredChats.map((chat) => {
                const isSelected = chat.chatId === selectedChatId;
                return (
                  <button
                    key={chat.chatId}
                    type="button"
                    onClick={() => setSelectedChatId(chat.chatId)}
                    className={`w-full text-left p-3.5 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#8B5CF6]/18 border-l-2 border-[#A78BFA]'
                        : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div
                        className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${
                          chat.isGroup
                            ? 'bg-[#8B5CF6]/15 border-[#8B5CF6]/30 text-[#C4B5FD]'
                            : 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                        }`}
                      >
                        {chat.isGroup ? (
                          <Users className="w-4 h-4" />
                        ) : (
                          <User className="w-4 h-4" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white truncate">
                            {chat.title}
                          </span>
                          <span className="text-[10px] font-mono tabular-nums text-[#7C759E] shrink-0">
                            {formatShortTime(chat.lastTimestamp)}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[#9E97C2]">
                          {chat.isGroup ? (
                            <>
                              <span>
                                {typeof chat.participantCount === 'number'
                                  ? `${chat.participantCount} members`
                                  : 'Group'}
                              </span>
                              {chat.isAdmin && (
                                <span className="inline-flex items-center gap-0.5 text-emerald-300 font-semibold">
                                  <ShieldCheck className="w-3 h-3" />
                                  Admin
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="font-mono tabular-nums">
                              {chat.phone ? `+${chat.phone}` : 'Private DM'}
                            </span>
                          )}
                          {chat.messageCount > 0 && (
                            <span className="ml-auto font-mono tabular-nums text-[#8B84AD]">
                              {chat.messageCount} msgs
                            </span>
                          )}
                        </div>

                        {chat.lastMessage && (
                          <p className="text-[11px] text-[#B6AFD4] truncate mt-1">
                            {chat.lastFromMe ? 'You: ' : chat.isGroup && chat.lastSender ? `${chat.lastSender}: ` : ''}
                            {chat.lastMessage}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Column 3: Live Chatting Viewer */}
        <section className="lg:col-span-5 glass-surface rounded-2xl flex flex-col h-[560px] lg:h-[680px] overflow-hidden">
          <div className="p-3.5 border-b border-white/[0.08] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-[#8B5CF6]/20 border border-[#A78BFA]/30 flex items-center justify-center shrink-0">
                <MessageSquare className="w-4 h-4 text-[#C4B5FD]" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xs sm:text-sm font-semibold text-white truncate">
                  {activeChat
                    ? activeChat.title
                    : activeSession
                      ? `Live Stream — ${activeSession.name}`
                      : 'Live Chatting Screen'}
                </h2>
                <p className="text-[11px] text-[#9E97C2] truncate font-mono">
                  {activeChat
                    ? activeChat.isGroup
                      ? `${activeChat.participantCount ?? '?'} members · Group Chat`
                      : activeChat.phone
                        ? `+${activeChat.phone} · Private Chat`
                        : activeChat.chatId
                    : activeSession
                      ? `${messages.length} live message(s) across all groups & DMs`
                      : 'Select a paired session'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setAutoScroll((v) => !v)}
              className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium shrink-0 cursor-pointer ${
                autoScroll
                  ? 'bg-[#8B5CF6]/20 border-[#A78BFA]/35 text-[#DDD6FE]'
                  : 'bg-white/[0.05] border-white/[0.1] text-[#8B84AD]'
              }`}
            >
              {autoScroll ? 'Auto-Scroll On' : 'Scroll Locked'}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2.5 bg-[#070410]/65">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-2">
                <MessageSquare className="w-8 h-8 text-[#5F5882]" />
                <p className="text-xs font-medium text-[#C4BFE0]">
                  No live messages captured in this view yet.
                </p>
                <p className="text-[11px] text-[#7C759E] max-w-sm">
                  As soon as this paired WhatsApp account sends or receives any message in a group or private DM, it will appear here in real time.
                </p>
              </div>
            ) : (
              messages.map((m, idx) => {
                const isOut = m.fromMe;
                const mediaIcon = renderMediaIcon(m.mediaType);
                return (
                  <div
                    key={`${m.id}-${idx}`}
                    className={`flex flex-col ${isOut ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 border space-y-1 ${
                        isOut
                          ? 'bg-[#5B21B6]/35 border-[#A78BFA]/30 text-white rounded-br-sm'
                          : 'bg-white/[0.06] border-white/[0.1] text-[#F5F3FF] rounded-bl-sm'
                      }`}
                    >
                      {/* Unified Live Feed shows which group or DM the message came from */}
                      {!selectedChatId && (
                        <div className="flex items-center gap-1.5 text-[10px] font-medium text-[#C4B5FD] pb-0.5 border-b border-white/[0.08]">
                          {m.isGroup ? (
                            <Users className="w-3 h-3 shrink-0" />
                          ) : (
                            <User className="w-3 h-3 shrink-0 text-sky-300" />
                          )}
                          <span className="truncate">{m.chatTitle}</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-3 text-[10px]">
                        <span
                          className={`font-semibold truncate ${
                            isOut ? 'text-emerald-300' : 'text-[#A78BFA]'
                          }`}
                        >
                          {isOut
                            ? 'You (Paired)'
                            : m.senderName}
                          {!isOut && m.senderPhone && !m.senderName.includes(m.senderPhone)
                            ? ` · +${m.senderPhone}`
                            : ''}
                        </span>
                        <span className="font-mono tabular-nums text-[#8B84AD] shrink-0">
                          {formatClockTime(m.timestamp)}
                        </span>
                      </div>

                      <div className="flex items-start gap-1.5 text-xs leading-relaxed break-words whitespace-pre-wrap">
                        {mediaIcon && <span className="mt-0.5">{mediaIcon}</span>}
                        <span>{m.text}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>
        </section>
      </div>
    </div>
  );
}
