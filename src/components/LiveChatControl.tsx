import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileText,
  Forward,
  Image as ImageIcon,
  Link2,
  Lock,
  LogOut,
  MapPin,
  MessageSquare,
  Mic,
  Paperclip,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Shield,
  ShieldCheck,
  ShieldOff,
  Square,
  Trash2,
  Unlock,
  UserMinus,
  UserPlus,
  Users,
  Video,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  ConnectionStatus,
  LiveChatMessageItem,
  LiveChatThreadItem,
  LiveControlOverview,
  LiveControlUserEntry,
  LiveGroupDetailItem,
  LiveSessionState,
  LiveStatusItem,
} from '../types/bot';

interface LiveChatControlProps {
  adminToken: string;
  onRefreshParent: () => Promise<void>;
}

type UserFilterMode = 'all' | 'active' | 'offline' | 'not_paired';
type ChatFilterMode = 'all' | 'dm' | 'group' | 'admin_groups';
type GroupPaneTab = 'messages' | 'admin';
type WorkspaceMode = 'chats' | 'statuses';

interface StagedAttachment {
  base64Data: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  previewUrl: string;
}

interface ShareTargetDraft {
  label: string;
  statusId?: string;
  sourceChatId?: string;
  sourceMsgId?: string;
  text?: string;
}

function formatClockTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDateTimeShort(ts: number | string | undefined): string {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function argbToCssHex(argb?: number): string {
  if (typeof argb !== 'number' || !Number.isFinite(argb)) return '#3B1D6E';
  const rgb = (argb >>> 0) & 0x00ffffff;
  return `#${rgb.toString(16).padStart(6, '0')}`;
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Failed to read selected file.'));
    reader.readAsDataURL(file);
  });
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Failed to read audio recording.'));
    reader.readAsDataURL(blob);
  });
}

export function LiveChatControl({ adminToken, onRefreshParent }: LiveChatControlProps) {
  const [overview, setOverview] = useState<LiveControlOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [userFilter, setUserFilter] = useState<UserFilterMode>('all');
  const [userSearch, setUserSearch] = useState('');

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('chats');
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
  const [failedMediaKeys, setFailedMediaKeys] = useState<Record<string, boolean>>({});

  // Media Attachment & Voice Recording State
  const [stagedAttachment, setStagedAttachment] = useState<StagedAttachment | null>(null);
  const [attachmentCaption, setAttachmentCaption] = useState('');
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedVoiceBlob, setRecordedVoiceBlob] = useState<{
    blob: Blob;
    url: string;
    mimeType: string;
    seconds: number;
  } | null>(null);

  // WhatsApp Statuses State
  const [statuses, setStatuses] = useState<LiveStatusItem[]>([]);
  const [loadingStatuses, setLoadingStatuses] = useState(false);
  const [statusScopeAll, setStatusScopeAll] = useState(true);
  const [statusSearch, setStatusSearch] = useState('');
  const [activeStatusId, setActiveStatusId] = useState<string | null>(null);

  // Post New Status Modal
  const [showPostStatusModal, setShowPostStatusModal] = useState(false);
  const [statusPostMode, setStatusPostMode] = useState<'text' | 'media'>('text');
  const [statusPostText, setStatusPostText] = useState('');
  const [statusPostBg, setStatusPostBg] = useState('#3B1D6E');
  const [statusPostMedia, setStatusPostMedia] = useState<StagedAttachment | null>(null);
  const [statusPostCaption, setStatusPostCaption] = useState('');

  // Share / Forward Modal & Lightbox Image Preview
  const [shareDraft, setShareDraft] = useState<ShareTargetDraft | null>(null);
  const [shareTargetInput, setShareTargetInput] = useState('');
  const [shareCaption, setShareCaption] = useState('');
  const [lightboxImageUrl, setLightboxImageUrl] = useState<{ url: string; title: string } | null>(
    null
  );

  // Group Admin Controls State
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const statusFileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceCancelledRef = useRef(false);

  const authHeaders = useMemo(
    () => ({ Authorization: `Bearer ${adminToken}` }),
    [adminToken]
  );

  const buildChatMediaUrl = useCallback(
    (sid: string, chatId: string, msgId: string, download = false) =>
      `/api/live-chat/sessions/${encodeURIComponent(sid)}/media?chatId=${encodeURIComponent(
        chatId
      )}&msgId=${encodeURIComponent(msgId)}${download ? '&download=1' : ''}&token=${encodeURIComponent(
        adminToken
      )}`,
    [adminToken]
  );

  const buildStatusMediaUrl = useCallback(
    (statusId: string, sid?: string | null, download = false) =>
      `/api/live-chat/statuses/${encodeURIComponent(statusId)}/media?${
        sid ? `sessionId=${encodeURIComponent(sid)}&` : ''
      }${download ? 'download=1&' : ''}token=${encodeURIComponent(adminToken)}`,
    [adminToken]
  );

  const triggerProtectedDownload = useCallback(
    async (url: string, fallbackName: string) => {
      try {
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          setFeedback({
            type: 'err',
            text: errData.error || 'Media file is unavailable for download.',
          });
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = fallbackName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
      } catch {
        setFeedback({ type: 'err', text: 'Failed to download media file.' });
      }
    },
    [authHeaders]
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

  const fetchStatuses = useCallback(
    async (showSpinner = false) => {
      if (showSpinner) setLoadingStatuses(true);
      try {
        const qs =
          !statusScopeAll && selectedSessionId
            ? `?sessionId=${encodeURIComponent(selectedSessionId)}`
            : '';
        const res = await fetch(`/api/live-chat/statuses${qs}`, {
          headers: authHeaders,
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok) {
          setStatuses(data.statuses || []);
        }
      } catch {
        // Ignore transient poll error
      } finally {
        if (showSpinner) setLoadingStatuses(false);
      }
    },
    [authHeaders, selectedSessionId, statusScopeAll]
  );

  useEffect(() => {
    void fetchOverview();
    const timer = setInterval(() => {
      if (!document.hidden) void fetchOverview();
    }, 2500);
    return () => clearInterval(timer);
  }, [fetchOverview]);

  useEffect(() => {
    void fetchStatuses(true);
    const timer = setInterval(() => {
      if (!document.hidden) void fetchStatuses(false);
    }, 5500);
    return () => clearInterval(timer);
  }, [fetchStatuses]);

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
    setFailedMediaKeys({});
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

  useEffect(() => {
    return () => {
      if (voiceTimerRef.current) window.clearInterval(voiceTimerRef.current);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

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

  const filteredStatuses = useMemo(() => {
    const q = statusSearch.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter(
      (s) =>
        s.pushName.toLowerCase().includes(q) ||
        s.senderPhone.includes(q) ||
        (s.caption || '').toLowerCase().includes(q) ||
        (s.textBody || '').toLowerCase().includes(q)
    );
  }, [statuses, statusSearch]);

  const activeStatusIndex = useMemo(
    () => filteredStatuses.findIndex((s) => s.id === activeStatusId),
    [filteredStatuses, activeStatusId]
  );

  const activeStatusItem = useMemo(
    () => (activeStatusIndex >= 0 ? filteredStatuses[activeStatusIndex] : null),
    [filteredStatuses, activeStatusIndex]
  );

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
    if (!selectedSessionId || !selectedChatId) return;

    if (stagedAttachment) {
      await handleSendStagedAttachment();
      return;
    }

    if (!replyText.trim()) return;
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

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 22 * 1024 * 1024) {
      setFeedback({ type: 'err', text: 'File is too large. Maximum supported size is 22 MB.' });
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setStagedAttachment({
        base64Data: dataUrl,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        sizeBytes: file.size,
        previewUrl: dataUrl,
      });
      setAttachmentCaption('');
    } catch {
      setFeedback({ type: 'err', text: 'Could not read selected file.' });
    }
  }

  async function handleSendStagedAttachment() {
    if (!selectedSessionId || !selectedChatId || !stagedAttachment) return;
    setSendingReply(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/send-media`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            target: selectedChatId,
            base64Data: stagedAttachment.base64Data,
            mimeType: stagedAttachment.mimeType,
            fileName: stagedAttachment.fileName,
            caption: attachmentCaption.trim(),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Failed to send attachment.' });
      } else {
        setStagedAttachment(null);
        setAttachmentCaption('');
        await fetchChatMessages(selectedSessionId, selectedChatId, false);
        await fetchSessionChats(selectedSessionId, false);
      }
    } catch {
      setFeedback({ type: 'err', text: 'Failed to upload media to server.' });
    } finally {
      setSendingReply(false);
    }
  }

  async function handleStartVoiceRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setFeedback({
        type: 'err',
        text: 'Browser microphone capture is unavailable here. You can attach any audio file instead.',
      });
      return;
    }
    setFeedback(null);
    if (recordedVoiceBlob) {
      URL.revokeObjectURL(recordedVoiceBlob.url);
      setRecordedVoiceBlob(null);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: preferredMime });
      voiceChunksRef.current = [];
      voiceCancelledRef.current = false;
      mediaRecorderRef.current = recorder;
      setRecordingSeconds(0);
      setRecordingVoice(true);

      const startedAt = Date.now();
      voiceTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      }, 400);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          voiceChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        if (voiceTimerRef.current) {
          window.clearInterval(voiceTimerRef.current);
          voiceTimerRef.current = null;
        }
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setRecordingVoice(false);

        if (voiceCancelledRef.current) {
          voiceChunksRef.current = [];
          return;
        }

        const mimeType = recorder.mimeType || preferredMime || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type: mimeType });
        voiceChunksRef.current = [];
        if (blob.size > 200) {
          const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          const url = URL.createObjectURL(blob);
          setRecordedVoiceBlob({ blob, url, mimeType, seconds: duration });
        }
      };

      recorder.start(200);
    } catch {
      setFeedback({
        type: 'err',
        text: 'Microphone permission denied or no mic found.',
      });
    }
  }

  function handleStopVoiceRecording(cancel: boolean) {
    voiceCancelledRef.current = cancel;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      if (voiceTimerRef.current) {
        window.clearInterval(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      setRecordingVoice(false);
    }
  }

  async function handleSendRecordedVoice() {
    if (!selectedSessionId || !selectedChatId || !recordedVoiceBlob) return;
    setSendingReply(true);
    setFeedback(null);
    try {
      const base64Data = await readBlobAsDataUrl(recordedVoiceBlob.blob);
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/send-media`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            target: selectedChatId,
            base64Data,
            mimeType: recordedVoiceBlob.mimeType,
            fileName: 'voice-note.webm',
            asVoiceNote: true,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Could not send voice note.' });
      } else {
        URL.revokeObjectURL(recordedVoiceBlob.url);
        setRecordedVoiceBlob(null);
        await fetchChatMessages(selectedSessionId, selectedChatId, false);
        await fetchSessionChats(selectedSessionId, false);
      }
    } catch {
      setFeedback({ type: 'err', text: 'Failed sending voice note.' });
    } finally {
      setSendingReply(false);
    }
  }

  async function handleStatusMediaFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 22 * 1024 * 1024) {
      setFeedback({ type: 'err', text: 'Status file exceeds 22 MB limit.' });
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    setStatusPostMedia({
      base64Data: dataUrl,
      mimeType: file.type || 'image/jpeg',
      fileName: file.name,
      sizeBytes: file.size,
      previewUrl: dataUrl,
    });
  }

  async function handlePostStatus(e: FormEvent) {
    e.preventDefault();
    if (!selectedSessionId) return;
    setBusyAction('post_status');
    setFeedback(null);
    try {
      const body =
        statusPostMode === 'text'
          ? { text: statusPostText.trim(), backgroundColor: statusPostBg }
          : {
              base64Data: statusPostMedia?.base64Data,
              mimeType: statusPostMedia?.mimeType,
              caption: statusPostCaption.trim(),
            };
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/post-status`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Could not post status.' });
      } else {
        setShowPostStatusModal(false);
        setStatusPostText('');
        setStatusPostMedia(null);
        setStatusPostCaption('');
        setFeedback({ type: 'ok', text: 'WhatsApp Status posted live!' });
        await fetchStatuses(false);
      }
    } catch {
      setFeedback({ type: 'err', text: 'Network error posting status.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleShareSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedSessionId || !shareDraft || !shareTargetInput.trim()) return;
    setBusyAction('share_item');
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/live-chat/sessions/${encodeURIComponent(selectedSessionId)}/share`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            target: shareTargetInput.trim(),
            statusId: shareDraft.statusId,
            sourceSessionId: selectedSessionId,
            sourceChatId: shareDraft.sourceChatId,
            sourceMsgId: shareDraft.sourceMsgId,
            caption: shareCaption.trim(),
            text: shareDraft.text,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFeedback({ type: 'err', text: data.error || 'Failed to share item.' });
      } else {
        setFeedback({ type: 'ok', text: `Shared cleanly to ${data.chatId || shareTargetInput}!` });
        setShareDraft(null);
        setShareTargetInput('');
        setShareCaption('');
        await fetchSessionChats(selectedSessionId, false);
        if (data.chatId && data.chatId === selectedChatId) {
          await fetchChatMessages(selectedSessionId, data.chatId, false);
        }
      }
    } catch {
      setFeedback({ type: 'err', text: 'Network error while sharing.' });
    } finally {
      setBusyAction(null);
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
        setWorkspaceMode('chats');
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
                WhatsApp Web Live Control Center
              </h2>
              <p className="text-xs text-[#9E97C2]">
                Real-time paired counts, live chats, voice notes, photos/videos/files, statuses viewer &amp; group admin control.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              void fetchOverview();
              void fetchStatuses(false);
            }}
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
          className={`flex items-center justify-between gap-3 text-xs px-4 py-3 rounded-xl border ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
              : 'bg-rose-500/10 border-rose-500/25 text-rose-200'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-white/60 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
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
                              {isSelected ? 'Opened' : 'Open Web App'}
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

      {/* Selected User WhatsApp Web Workspace */}
      <section className="glass-surface rounded-2xl overflow-hidden">
        {!selectedSessionId ? (
          <div className="p-12 text-center space-y-2">
            <MessageSquare className="w-8 h-8 text-[#8B5CF6] mx-auto" />
            <div className="text-base font-semibold text-white">
              Select Any Paired User Above
            </div>
            <p className="text-xs text-[#9E97C2] max-w-md mx-auto">
              Click &ldquo;Open Web App&rdquo; to view chats, play/send voice notes, inspect &amp; download statuses, share media, and manage group admins.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.07]">
            {/* WhatsApp Web Session Top Header */}
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
                    {sessionMeta?.connected
                      ? 'WhatsApp Connected'
                      : `Status: ${sessionMeta?.status || 'offline'}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#9E97C2] tabular-nums">
                  <span>{chatStats.totalChats} Chats</span>
                  <span aria-hidden="true">·</span>
                  <span>{chatStats.dmCount} DMs</span>
                  <span aria-hidden="true">·</span>
                  <span>{chatStats.groupCount} Groups</span>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-300 font-semibold">
                    {chatStats.adminGroupCount} Admin Groups
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#C4B5FD] font-semibold">
                    {statuses.length} Live Statuses
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Workspace Switch: Chats vs Statuses */}
                <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => setWorkspaceMode('chats')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                      workspaceMode === 'chats'
                        ? 'bg-[#8B5CF6] text-white'
                        : 'text-[#A9A2C8] hover:text-white'
                    }`}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Chats &amp; Groups
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setWorkspaceMode('statuses');
                      void fetchStatuses(true);
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                      workspaceMode === 'statuses'
                        ? 'bg-emerald-600 text-white'
                        : 'text-[#A9A2C8] hover:text-white'
                    }`}
                  >
                    <Radio className="w-3.5 h-3.5" />
                    Statuses ({statuses.length})
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setShowPostStatusModal(true)}
                  disabled={!sessionMeta?.connected}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-xs font-semibold text-emerald-200 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Post Status
                </button>

                <button
                  type="button"
                  onClick={() => setShowNewDmForm((prev) => !prev)}
                  disabled={!sessionMeta?.connected}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New Chat
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
                  Online
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
                  Offline
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void fetchSessionChats(selectedSessionId, true);
                    void fetchStatuses(false);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-medium text-white whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingChats ? 'animate-spin' : ''}`} />
                  Sync
                </button>
              </div>
            </div>

            {/* Quick Bar: New DM + Join Group via Invite */}
            {(showNewDmForm || sessionMeta?.connected) && (
              <div className="px-5 py-3 bg-[#090613]/70 flex flex-wrap items-center gap-4">
                {showNewDmForm && (
                  <form
                    onSubmit={handleStartNewDm}
                    className="flex flex-wrap items-center gap-2 flex-1 min-w-[280px]"
                  >
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

            {/* WORKSPACE CONTENT: STATUSES VIEW OR CHATS SPLIT VIEW */}
            {workspaceMode === 'statuses' ? (
              <div className="p-5 space-y-5 min-h-[540px]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06]">
                      <button
                        type="button"
                        onClick={() => setStatusScopeAll(true)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
                          statusScopeAll
                            ? 'bg-[#8B5CF6] text-white'
                            : 'text-[#A9A2C8] hover:text-white'
                        }`}
                      >
                        All Active Statuses
                      </button>
                      <button
                        type="button"
                        onClick={() => setStatusScopeAll(false)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
                          !statusScopeAll
                            ? 'bg-[#8B5CF6] text-white'
                            : 'text-[#A9A2C8] hover:text-white'
                        }`}
                      >
                        This Account Only
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative w-64">
                      <Search className="w-3.5 h-3.5 text-[#7C759E] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={statusSearch}
                        onChange={(e) => setStatusSearch(e.target.value)}
                        placeholder="Search contact or status text..."
                        className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.08] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void fetchStatuses(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.13] text-xs font-semibold text-white cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingStatuses ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>
                </div>

                {loadingStatuses && filteredStatuses.length === 0 ? (
                  <div className="py-16 text-center text-xs text-[#8B84AD]">
                    Loading live WhatsApp statuses...
                  </div>
                ) : filteredStatuses.length === 0 ? (
                  <div className="py-16 text-center space-y-2">
                    <Radio className="w-8 h-8 text-emerald-400 mx-auto" />
                    <div className="text-sm font-semibold text-white">
                      No WhatsApp Statuses Captured Yet
                    </div>
                    <p className="text-xs text-[#9E97C2] max-w-md mx-auto">
                      As soon as contacts post photo, video, voice, or text statuses while WhatsApp is connected, they appear here automatically for preview, download, and sharing.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {filteredStatuses.map((st) => {
                      const stMediaUrl = buildStatusMediaUrl(st.id, selectedSessionId, false);
                      const stDownloadUrl = buildStatusMediaUrl(st.id, selectedSessionId, true);
                      const ext =
                        st.mediaType === 'video'
                          ? 'mp4'
                          : st.mediaType === 'audio'
                            ? 'ogg'
                            : st.mediaType === 'text'
                              ? 'txt'
                              : 'jpg';
                      const dlName = `status_${st.senderPhone || st.pushName}_${st.id.slice(-6)}.${ext}`;

                      return (
                        <div
                          key={st.id}
                          className="rounded-xl bg-[#0A0714]/90 border border-white/[0.08] overflow-hidden flex flex-col"
                        >
                          {/* Thumbnail / Preview Area */}
                          <div
                            onClick={() => setActiveStatusId(st.id)}
                            className="relative h-44 bg-[#07050F] flex items-center justify-center overflow-hidden cursor-pointer group"
                          >
                            {st.mediaType === 'image' ? (
                              <img
                                src={stMediaUrl}
                                alt={st.pushName}
                                loading="lazy"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              />
                            ) : st.mediaType === 'video' ? (
                              <div className="w-full h-full relative bg-black flex items-center justify-center">
                                <video
                                  src={stMediaUrl}
                                  muted
                                  preload="metadata"
                                  className="w-full h-full object-cover opacity-85"
                                />
                                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                                  <Video className="w-8 h-8 text-white" />
                                </div>
                              </div>
                            ) : st.mediaType === 'audio' ? (
                              <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-4 bg-gradient-to-br from-emerald-950/60 to-[#140E27]">
                                <Mic className="w-8 h-8 text-emerald-400" />
                                <span className="text-xs font-semibold text-white">
                                  Voice Status {st.seconds ? `· ${formatDuration(st.seconds)}` : ''}
                                </span>
                              </div>
                            ) : (
                              <div
                                style={{ backgroundColor: argbToCssHex(st.backgroundArgb) }}
                                className="w-full h-full p-4 flex items-center justify-center text-center"
                              >
                                <p className="text-xs font-medium text-white line-clamp-5">
                                  {st.textBody || st.caption}
                                </p>
                              </div>
                            )}
                          </div>

                          {/* Card Footer Metadata & Actions */}
                          <div className="p-3.5 space-y-2.5 flex-1 flex flex-col justify-between">
                            <div>
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-semibold text-white truncate">
                                  {st.pushName}
                                </span>
                                <span className="font-mono tabular-nums text-[11px] text-[#8B84AD] shrink-0">
                                  {formatClockTime(st.timestampMs)}
                                </span>
                              </div>
                              <div className="text-[11px] text-[#9E97C2] mt-0.5 truncate">
                                {st.senderPhone ? `+${st.senderPhone}` : 'Contact'} ·{' '}
                                <span className="capitalize">{st.mediaType}</span>
                              </div>
                              {st.caption && st.mediaType !== 'text' && (
                                <p className="text-xs text-[#D6D0F0] line-clamp-2 mt-1">
                                  {st.caption}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5 pt-1 border-t border-white/[0.06]">
                              <button
                                type="button"
                                onClick={() => setActiveStatusId(st.id)}
                                className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.14] text-[11px] font-semibold text-white cursor-pointer"
                              >
                                <Eye className="w-3 h-3" />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => void triggerProtectedDownload(stDownloadUrl, dlName)}
                                className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-[11px] font-semibold text-emerald-200 cursor-pointer"
                              >
                                <Download className="w-3 h-3" />
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setShareDraft({
                                    label: `${st.pushName}'s ${st.mediaType} status`,
                                    statusId: st.id,
                                  });
                                  setShareTargetInput(selectedChatId || '');
                                  setShareCaption(st.caption || '');
                                }}
                                className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#8B5CF6]/20 hover:bg-[#8B5CF6]/35 text-[11px] font-semibold text-[#DDD6FE] cursor-pointer"
                              >
                                <Forward className="w-3 h-3" />
                                Share
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              /* 2-Column Split: Left = All Chats & Admin Groups, Right = Conversation + Group Admin Control */
              <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[600px]">
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

                  <div className="flex-1 max-h-[590px] overflow-y-auto divide-y divide-white/[0.05]">
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
                                        <span className="text-emerald-400 font-semibold">
                                          SuperAdmin
                                        </span>
                                      ) : chat.isAdmin ? (
                                        <span className="text-emerald-400 font-semibold">
                                          Admin
                                        </span>
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
                        View &amp; play voice notes, images, videos, stickers, documents, send voice messages from mic, share files, or manage group admins.
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
                        <div className="flex-1 p-5 space-y-5 max-h-[590px] overflow-y-auto">
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
                                      void handleGroupAction('description', {
                                        description: editDesc,
                                      });
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
                                  disabled={
                                    !groupDetail.isBotAdmin ||
                                    !addMemberPhone.trim() ||
                                    Boolean(busyAction)
                                  }
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
                          {/* Live Message Stream with Inline Media & Voice Playback */}
                          <div className="flex-1 p-5 space-y-3 max-h-[470px] overflow-y-auto bg-[#07050F]/45">
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
                                  Incoming &amp; outgoing texts, voice notes, photos, videos, and files appear here live, or send one below now.
                                </p>
                              </div>
                            ) : (
                              messages.map((m) => {
                                const msgKey = m.key?.id || m.id;
                                const mediaFailed = Boolean(failedMediaKeys[msgKey]);
                                const mediaUrl = buildChatMediaUrl(selectedSessionId, m.chatId, msgKey, false);
                                const downloadUrl = buildChatMediaUrl(selectedSessionId, m.chatId, msgKey, true);
                                const dlFilename =
                                  m.fileName ||
                                  `${m.mediaType}_${msgKey.slice(-6)}.${
                                    m.mediaType === 'video'
                                      ? 'mp4'
                                      : m.mediaType === 'audio'
                                        ? 'ogg'
                                        : m.mediaType === 'sticker'
                                          ? 'webp'
                                          : 'jpg'
                                  }`;

                                return (
                                  <div
                                    key={`${m.id}:${m.timestamp}`}
                                    className={`flex flex-col ${
                                      m.fromMe ? 'items-end' : 'items-start'
                                    }`}
                                  >
                                    <div
                                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 border text-xs space-y-2 ${
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
                                          <button
                                            type="button"
                                            title="Share / Forward message"
                                            onClick={() => {
                                              setShareDraft({
                                                label: `${m.mediaType} from ${m.senderName}`,
                                                sourceChatId: m.chatId,
                                                sourceMsgId: m.hasMedia ? msgKey : undefined,
                                                text: !m.hasMedia ? m.text : undefined,
                                              });
                                              setShareTargetInput('');
                                              setShareCaption(m.hasMedia && m.text !== `[Photo]` && m.text !== `[Video]` && m.text !== `[Voice Note]` ? m.text : '');
                                            }}
                                            className="text-[#8B84AD] hover:text-[#DDD6FE] cursor-pointer"
                                          >
                                            <Forward className="w-3 h-3" />
                                          </button>
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

                                      {/* Rich Media Renderer */}
                                      {m.mediaType === 'image' && m.hasMedia && !mediaFailed && (
                                        <div className="space-y-1.5">
                                          <img
                                            src={mediaUrl}
                                            alt={m.text || 'WhatsApp photo'}
                                            loading="lazy"
                                            onClick={() =>
                                              setLightboxImageUrl({
                                                url: mediaUrl,
                                                title: `${m.senderName} · ${formatClockTime(m.timestamp)}`,
                                              })
                                            }
                                            onError={() =>
                                              setFailedMediaKeys((prev) => ({
                                                ...prev,
                                                [msgKey]: true,
                                              }))
                                            }
                                            className="max-h-64 rounded-xl object-cover cursor-pointer border border-white/[0.08]"
                                          />
                                          <div className="flex items-center justify-end gap-2">
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void triggerProtectedDownload(downloadUrl, dlFilename)
                                              }
                                              className="inline-flex items-center gap-1 text-[11px] text-[#C4B5FD] hover:text-white cursor-pointer"
                                            >
                                              <Download className="w-3 h-3" />
                                              Download Photo
                                            </button>
                                          </div>
                                        </div>
                                      )}

                                      {m.mediaType === 'sticker' && m.hasMedia && !mediaFailed && (
                                        <div className="flex items-center gap-3">
                                          <img
                                            src={mediaUrl}
                                            alt="WhatsApp sticker"
                                            loading="lazy"
                                            onError={() =>
                                              setFailedMediaKeys((prev) => ({
                                                ...prev,
                                                [msgKey]: true,
                                              }))
                                            }
                                            className="w-28 h-28 object-contain"
                                          />
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void triggerProtectedDownload(downloadUrl, dlFilename)
                                            }
                                            className="inline-flex items-center gap-1 text-[11px] text-[#C4B5FD] hover:text-white cursor-pointer"
                                          >
                                            <Download className="w-3 h-3" />
                                            Save
                                          </button>
                                        </div>
                                      )}

                                      {m.mediaType === 'video' && m.hasMedia && !mediaFailed && (
                                        <div className="space-y-1.5">
                                          <video
                                            src={mediaUrl}
                                            controls
                                            playsInline
                                            preload="metadata"
                                            onError={() =>
                                              setFailedMediaKeys((prev) => ({
                                                ...prev,
                                                [msgKey]: true,
                                              }))
                                            }
                                            className="max-h-64 w-full rounded-xl bg-black border border-white/[0.08]"
                                          />
                                          <div className="flex items-center justify-between text-[11px] text-[#9E97C2]">
                                            <span>{m.seconds ? formatDuration(m.seconds) : 'Video'}</span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void triggerProtectedDownload(downloadUrl, dlFilename)
                                              }
                                              className="inline-flex items-center gap-1 text-[#C4B5FD] hover:text-white cursor-pointer"
                                            >
                                              <Download className="w-3 h-3" />
                                              Download Video
                                            </button>
                                          </div>
                                        </div>
                                      )}

                                      {m.mediaType === 'audio' && m.hasMedia && !mediaFailed && (
                                        <div className="rounded-xl bg-black/35 border border-white/[0.08] p-2.5 space-y-2 min-w-[240px]">
                                          <div className="flex items-center justify-between gap-2 text-[11px] text-[#C4BFE0]">
                                            <span className="inline-flex items-center gap-1.5 font-medium">
                                              <Mic className="w-3.5 h-3.5 text-emerald-400" />
                                              {m.ptt ? 'Voice Note' : 'Audio'}
                                              {m.seconds ? ` · ${formatDuration(m.seconds)}` : ''}
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void triggerProtectedDownload(downloadUrl, dlFilename)
                                              }
                                              className="inline-flex items-center gap-1 text-[#C4B5FD] hover:text-white cursor-pointer"
                                            >
                                              <Download className="w-3 h-3" />
                                              Save
                                            </button>
                                          </div>
                                          <audio
                                            src={mediaUrl}
                                            controls
                                            preload="metadata"
                                            onError={() =>
                                              setFailedMediaKeys((prev) => ({
                                                ...prev,
                                                [msgKey]: true,
                                              }))
                                            }
                                            className="w-full h-9"
                                          />
                                        </div>
                                      )}

                                      {m.mediaType === 'document' && m.hasMedia && (
                                        <div className="flex items-center justify-between gap-3 rounded-xl bg-black/35 border border-white/[0.08] px-3 py-2.5">
                                          <div className="flex items-center gap-2.5 min-w-0">
                                            <FileText className="w-4 h-4 text-[#A78BFA] shrink-0" />
                                            <div className="min-w-0">
                                              <div className="font-semibold text-white truncate">
                                                {m.fileName || 'Document'}
                                              </div>
                                              <div className="text-[10px] text-[#8B84AD] truncate">
                                                {m.mimetype || 'application/octet-stream'}
                                              </div>
                                            </div>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              void triggerProtectedDownload(downloadUrl, dlFilename)
                                            }
                                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[11px] font-semibold text-white shrink-0 cursor-pointer"
                                          >
                                            <Download className="w-3 h-3" />
                                            Download
                                          </button>
                                        </div>
                                      )}

                                      {m.mediaType === 'location' && (
                                        <div className="flex items-center justify-between gap-3 rounded-xl bg-black/30 border border-white/[0.08] px-3 py-2">
                                          <div className="flex items-center gap-2 min-w-0">
                                            <MapPin className="w-4 h-4 text-emerald-400 shrink-0" />
                                            <span className="truncate">
                                              {m.locationName ||
                                                (typeof m.locationLat === 'number' &&
                                                typeof m.locationLng === 'number'
                                                  ? `${m.locationLat.toFixed(5)}, ${m.locationLng.toFixed(5)}`
                                                  : 'Shared Location')}
                                            </span>
                                          </div>
                                          {typeof m.locationLat === 'number' &&
                                            typeof m.locationLng === 'number' && (
                                              <a
                                                href={`https://maps.google.com/?q=${m.locationLat},${m.locationLng}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] text-[#C4B5FD] hover:text-white shrink-0"
                                              >
                                                Open Map
                                              </a>
                                            )}
                                        </div>
                                      )}

                                      {mediaFailed && m.hasMedia && (
                                        <div className="text-[11px] text-amber-300/85">
                                          Live media cache expired — new media messages play &amp; preview inline.
                                        </div>
                                      )}

                                      {/* Message Caption or Text */}
                                      {m.text &&
                                        m.text !== '[Photo]' &&
                                        m.text !== '[Video]' &&
                                        m.text !== '[Voice Note]' &&
                                        m.text !== '[Audio]' &&
                                        m.text !== '[Sticker]' &&
                                        m.text !== m.fileName && (
                                          <div className="whitespace-pre-wrap break-words leading-relaxed">
                                            {m.text}
                                          </div>
                                        )}
                                    </div>
                                  </div>
                                );
                              })
                            )}
                            <div ref={messagesEndRef} />
                          </div>

                          {/* Staged File Attachment Preview Bar */}
                          {stagedAttachment && (
                            <div className="px-4 py-3 border-t border-white/[0.07] bg-[#0B0816] flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                {stagedAttachment.mimeType.startsWith('image/') ? (
                                  <img
                                    src={stagedAttachment.previewUrl}
                                    alt={stagedAttachment.fileName}
                                    className="w-12 h-12 rounded-lg object-cover border border-white/[0.1]"
                                  />
                                ) : stagedAttachment.mimeType.startsWith('video/') ? (
                                  <Video className="w-6 h-6 text-[#A78BFA] shrink-0" />
                                ) : stagedAttachment.mimeType.startsWith('audio/') ? (
                                  <Volume2 className="w-6 h-6 text-emerald-400 shrink-0" />
                                ) : (
                                  <FileText className="w-6 h-6 text-[#A78BFA] shrink-0" />
                                )}
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-white truncate">
                                    {stagedAttachment.fileName}
                                  </div>
                                  <div className="text-[11px] text-[#9E97C2]">
                                    {stagedAttachment.mimeType} · {formatBytes(stagedAttachment.sizeBytes)}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 flex-1 min-w-[220px] justify-end">
                                <input
                                  type="text"
                                  value={attachmentCaption}
                                  onChange={(e) => setAttachmentCaption(e.target.value)}
                                  placeholder="Optional caption..."
                                  className="flex-1 px-3 py-1.5 rounded-lg bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleSendStagedAttachment()}
                                  disabled={sendingReply}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer disabled:opacity-45"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  {sendingReply ? 'Sending...' : 'Send Media'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setStagedAttachment(null);
                                    setAttachmentCaption('');
                                  }}
                                  className="p-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-white cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Recorded Voice Preview Bar */}
                          {recordedVoiceBlob && !recordingVoice && (
                            <div className="px-4 py-3 border-t border-white/[0.07] bg-emerald-950/25 flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-3 flex-1 min-w-[220px]">
                                <Mic className="w-4 h-4 text-emerald-400 shrink-0" />
                                <span className="text-xs font-semibold text-white shrink-0">
                                  Voice Note ({formatDuration(recordedVoiceBlob.seconds)})
                                </span>
                                <audio
                                  src={recordedVoiceBlob.url}
                                  controls
                                  className="h-8 flex-1 max-w-xs"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={sendingReply}
                                  onClick={() => void handleSendRecordedVoice()}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer disabled:opacity-45"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  {sendingReply ? 'Sending Voice...' : 'Send Voice Note'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    URL.revokeObjectURL(recordedVoiceBlob.url);
                                    setRecordedVoiceBlob(null);
                                  }}
                                  className="p-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-white cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          )}

                          {/* WhatsApp Web Composer Bar (Attach + Record Voice + Text Send) */}
                          <form
                            onSubmit={handleSendReply}
                            className="p-4 border-t border-white/[0.07] bg-white/[0.02] flex items-center gap-2"
                          >
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
                              onChange={handleFileSelected}
                              className="hidden"
                            />
                            <button
                              type="button"
                              title="Share photo, video, audio, or document"
                              disabled={!sessionMeta?.connected || sendingReply || recordingVoice}
                              onClick={() => fileInputRef.current?.click()}
                              className="p-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.14] text-[#C4B5FD] hover:text-white cursor-pointer disabled:opacity-45 shrink-0"
                            >
                              <Paperclip className="w-4 h-4" />
                            </button>

                            {recordingVoice ? (
                              <div className="flex-1 flex items-center justify-between gap-3 px-4 py-2 rounded-xl bg-rose-500/15 border border-rose-500/35">
                                <div className="flex items-center gap-2.5 text-xs font-semibold text-rose-200">
                                  <Mic className="w-4 h-4 text-rose-400" />
                                  <span>Recording Voice Note...</span>
                                  <span className="font-mono tabular-nums text-white">
                                    {formatDuration(recordingSeconds)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleStopVoiceRecording(true)}
                                    className="px-2.5 py-1 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-xs text-white cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleStopVoiceRecording(false)}
                                    className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer"
                                  >
                                    <Square className="w-3 h-3" />
                                    Finish &amp; Review
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  title="Record Voice Note"
                                  disabled={!sessionMeta?.connected || sendingReply}
                                  onClick={() => void handleStartVoiceRecording()}
                                  className="p-2.5 rounded-xl bg-white/[0.06] hover:bg-emerald-500/20 text-emerald-300 hover:text-emerald-200 cursor-pointer disabled:opacity-45 shrink-0"
                                >
                                  <Mic className="w-4 h-4" />
                                </button>

                                <input
                                  type="text"
                                  value={replyText}
                                  onChange={(e) => setReplyText(e.target.value)}
                                  disabled={!sessionMeta?.connected || sendingReply}
                                  placeholder={
                                    sessionMeta?.connected
                                      ? `Type a message as +${
                                          selectedUserEntry?.number || sessionMeta.phone
                                        } into ${selectedChat.name}...`
                                      : 'User WhatsApp session is offline — reconnect to send messages'
                                  }
                                  className="flex-1 px-4 py-2.5 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6] disabled:opacity-50"
                                />

                                <button
                                  type="submit"
                                  disabled={
                                    !sessionMeta?.connected ||
                                    (!replyText.trim() && !stagedAttachment) ||
                                    sendingReply
                                  }
                                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#8B5CF6] to-[#7C3AED] hover:from-[#9D74F7] hover:to-[#8B5CF6] text-xs font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  {sendingReply ? 'Sending...' : 'Send'}
                                </button>
                              </>
                            )}
                          </form>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Full-Screen Status Viewer Modal */}
      {activeStatusItem && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-[#100B1E] border border-white/[0.12] overflow-hidden shadow-2xl">
            <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-white">{activeStatusItem.pushName}</div>
                <div className="text-[11px] text-[#9E97C2]">
                  {activeStatusItem.senderPhone ? `+${activeStatusItem.senderPhone}` : 'Contact'} ·{' '}
                  {formatDateTimeShort(activeStatusItem.timestampMs)} ·{' '}
                  <span className="capitalize">{activeStatusItem.mediaType}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const ext =
                      activeStatusItem.mediaType === 'video'
                        ? 'mp4'
                        : activeStatusItem.mediaType === 'audio'
                          ? 'ogg'
                          : activeStatusItem.mediaType === 'text'
                            ? 'txt'
                            : 'jpg';
                    void triggerProtectedDownload(
                      buildStatusMediaUrl(activeStatusItem.id, selectedSessionId, true),
                      `status_${activeStatusItem.senderPhone || activeStatusItem.pushName}.${ext}`
                    );
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Status
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShareDraft({
                      label: `${activeStatusItem.pushName}'s ${activeStatusItem.mediaType} status`,
                      statusId: activeStatusItem.id,
                    });
                    setShareTargetInput(selectedChatId || '');
                    setShareCaption(activeStatusItem.caption || '');
                    setActiveStatusId(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] text-xs font-semibold text-white cursor-pointer"
                >
                  <Forward className="w-3.5 h-3.5" />
                  Share
                </button>
                <button
                  type="button"
                  onClick={() => setActiveStatusId(null)}
                  className="p-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.16] text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="relative bg-black/60 min-h-[340px] max-h-[68vh] flex items-center justify-center p-4">
              {activeStatusIndex > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveStatusId(filteredStatuses[activeStatusIndex - 1].id)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black text-white cursor-pointer z-10"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}

              {activeStatusItem.mediaType === 'image' ? (
                <img
                  src={buildStatusMediaUrl(activeStatusItem.id, selectedSessionId, false)}
                  alt={activeStatusItem.pushName}
                  className="max-h-[58vh] rounded-xl object-contain"
                />
              ) : activeStatusItem.mediaType === 'video' ? (
                <video
                  src={buildStatusMediaUrl(activeStatusItem.id, selectedSessionId, false)}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[58vh] w-full rounded-xl"
                />
              ) : activeStatusItem.mediaType === 'audio' ? (
                <div className="w-full max-w-md rounded-2xl bg-[#16102B] border border-white/[0.1] p-6 space-y-4 text-center">
                  <Mic className="w-10 h-10 text-emerald-400 mx-auto" />
                  <div className="text-sm font-semibold text-white">
                    Voice Status {activeStatusItem.seconds ? `· ${formatDuration(activeStatusItem.seconds)}` : ''}
                  </div>
                  <audio
                    src={buildStatusMediaUrl(activeStatusItem.id, selectedSessionId, false)}
                    controls
                    autoPlay
                    className="w-full"
                  />
                </div>
              ) : (
                <div
                  style={{ backgroundColor: argbToCssHex(activeStatusItem.backgroundArgb) }}
                  className="w-full min-h-[260px] rounded-2xl p-8 flex items-center justify-center text-center"
                >
                  <p className="text-lg font-semibold text-white whitespace-pre-wrap break-words">
                    {activeStatusItem.textBody || activeStatusItem.caption}
                  </p>
                </div>
              )}

              {activeStatusIndex >= 0 && activeStatusIndex < filteredStatuses.length - 1 && (
                <button
                  type="button"
                  onClick={() => setActiveStatusId(filteredStatuses[activeStatusIndex + 1].id)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black text-white cursor-pointer z-10"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}
            </div>

            {activeStatusItem.caption && activeStatusItem.mediaType !== 'text' && (
              <div className="px-5 py-3 border-t border-white/[0.08] text-xs text-[#E4DFFF] whitespace-pre-wrap">
                {activeStatusItem.caption}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Post New WhatsApp Status Modal */}
      {showPostStatusModal && selectedSessionId && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handlePostStatus}
            className="w-full max-w-lg rounded-2xl bg-[#100B1E] border border-white/[0.12] p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">Post WhatsApp Status</h3>
              <button
                type="button"
                onClick={() => setShowPostStatusModal(false)}
                className="p-1.5 rounded-lg bg-white/[0.08] text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0816] border border-white/[0.06] w-fit">
              <button
                type="button"
                onClick={() => setStatusPostMode('text')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                  statusPostMode === 'text' ? 'bg-[#8B5CF6] text-white' : 'text-[#A9A2C8]'
                }`}
              >
                Text Status
              </button>
              <button
                type="button"
                onClick={() => setStatusPostMode('media')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                  statusPostMode === 'media' ? 'bg-[#8B5CF6] text-white' : 'text-[#A9A2C8]'
                }`}
              >
                Photo / Video / Audio Status
              </button>
            </div>

            {statusPostMode === 'text' ? (
              <div className="space-y-3">
                <textarea
                  rows={4}
                  value={statusPostText}
                  onChange={(e) => setStatusPostText(e.target.value)}
                  placeholder="Write your WhatsApp text status..."
                  required
                  style={{ backgroundColor: statusPostBg }}
                  className="w-full rounded-xl border border-white/[0.15] p-4 text-sm font-medium text-white placeholder:text-white/60 focus:outline-none"
                />
                <div className="flex items-center gap-2 text-xs text-[#9E97C2]">
                  <span>Background:</span>
                  {['#3B1D6E', '#065F46', '#1E3A8A', '#881337', '#18181B'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setStatusPostBg(c)}
                      style={{ backgroundColor: c }}
                      className={`w-6 h-6 rounded-lg border cursor-pointer ${
                        statusPostBg === c ? 'border-white scale-110' : 'border-white/25'
                      }`}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <input
                  ref={statusFileInputRef}
                  type="file"
                  accept="image/*,video/*,audio/*"
                  onChange={handleStatusMediaFileSelected}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => statusFileInputRef.current?.click()}
                  className="w-full py-6 rounded-xl border border-dashed border-white/[0.2] hover:border-[#8B5CF6] bg-[#0A0714] text-xs text-[#C4BFE0] flex flex-col items-center gap-2 cursor-pointer"
                >
                  <ImageIcon className="w-6 h-6 text-[#A78BFA]" />
                  <span>
                    {statusPostMedia
                      ? `${statusPostMedia.fileName} (${formatBytes(statusPostMedia.sizeBytes)})`
                      : 'Choose Photo, Video, or Audio file to post as Status'}
                  </span>
                </button>
                <input
                  type="text"
                  value={statusPostCaption}
                  onChange={(e) => setStatusPostCaption(e.target.value)}
                  placeholder="Optional caption..."
                  className="w-full px-3.5 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowPostStatusModal(false)}
                className="px-4 py-2 rounded-xl bg-white/[0.08] text-xs font-medium text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  busyAction === 'post_status' ||
                  (statusPostMode === 'text' ? !statusPostText.trim() : !statusPostMedia)
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer disabled:opacity-45"
              >
                <Send className="w-3.5 h-3.5" />
                {busyAction === 'post_status' ? 'Posting...' : 'Publish Status'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Share / Forward Modal */}
      {shareDraft && selectedSessionId && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleShareSubmit}
            className="w-full max-w-md rounded-2xl bg-[#100B1E] border border-white/[0.12] p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-white">Share to WhatsApp Chat</h3>
                <p className="text-[11px] text-[#9E97C2]">{shareDraft.label}</p>
              </div>
              <button
                type="button"
                onClick={() => setShareDraft(null)}
                className="p-1.5 rounded-lg bg-white/[0.08] text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {chats.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs text-[#9E97C2]">Quick Pick Contact or Group</label>
                <select
                  value={shareTargetInput}
                  onChange={(e) => setShareTargetInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                >
                  <option value="">-- Choose from loaded chats or type number below --</option>
                  {chats.slice(0, 80).map((c) => (
                    <option key={c.chatId} value={c.chatId}>
                      [{c.chatType === 'group' ? 'Group' : 'DM'}] {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs text-[#9E97C2]">Recipient Number or JID</label>
              <input
                type="text"
                value={shareTargetInput}
                onChange={(e) => setShareTargetInput(e.target.value)}
                placeholder="e.g. 923001234567 or group JID"
                required
                className="w-full px-3.5 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs font-mono text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-[#9E97C2]">Optional Caption / Note</label>
              <input
                type="text"
                value={shareCaption}
                onChange={(e) => setShareCaption(e.target.value)}
                placeholder="Add note..."
                className="w-full px-3.5 py-2 rounded-xl bg-[#0A0714] border border-white/[0.1] text-xs text-white placeholder:text-[#5F5882] focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShareDraft(null)}
                className="px-4 py-2 rounded-xl bg-white/[0.08] text-xs font-medium text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!shareTargetInput.trim() || busyAction === 'share_item'}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-xs font-semibold text-white cursor-pointer disabled:opacity-45"
              >
                <Forward className="w-3.5 h-3.5" />
                {busyAction === 'share_item' ? 'Sharing...' : 'Send & Share'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Image Lightbox Modal */}
      {lightboxImageUrl && (
        <div
          onClick={() => setLightboxImageUrl(null)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-w-4xl w-full space-y-3 text-center"
          >
            <div className="flex items-center justify-between text-xs text-white px-2">
              <span className="font-semibold">{lightboxImageUrl.title}</span>
              <button
                type="button"
                onClick={() => setLightboxImageUrl(null)}
                className="p-1.5 rounded-lg bg-white/[0.1] text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <img
              src={lightboxImageUrl.url}
              alt={lightboxImageUrl.title}
              className="max-h-[82vh] mx-auto rounded-xl object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
}
