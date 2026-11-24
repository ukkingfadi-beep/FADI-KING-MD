import type { WASocket } from '@whiskeysockets/baileys';
import nodemailer from 'nodemailer';
import { normalizePhone } from '../config/bot.config.ts';
import { dbGetSync, dbSetSync, registerDbHydrationHook } from './db.ts';
import { jidUserPart } from './jidHelper.ts';
import { logger } from './logger.ts';

export type ReportActionType = 'ban' | 'unban';

export interface ReportTemplate {
  id: string;
  type: ReportActionType;
  title: string;
  body: string;
  enabled: boolean;
  createdAt: string;
}

export interface ReportSettings {
  banRepeatCount: number;
  unbanRepeatCount: number;
  blockOnBan: boolean;
  unblockOnUnban: boolean;
  sendSpamStanzaOnBan: boolean;
  echoReportsInChat: boolean;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  supportRecipients: string;
}

export interface ReportExecutionLog {
  id: string;
  type: ReportActionType;
  targetNumber: string;
  targetJid: string;
  triggeredBy: string;
  templateCount: number;
  totalReportsFired: number;
  spamStanzasAccepted: number;
  spamStanzasAttempted: number;
  emailsSent: number;
  emailsAttempted: number;
  emailError?: string;
  blockActionStatus: string;
  appliedReports: Array<{ title: string; body: string }>;
  summary: string;
  timestamp: string;
}

const DEFAULT_SETTINGS: ReportSettings = {
  banRepeatCount: 1,
  unbanRepeatCount: 1,
  blockOnBan: true,
  unblockOnUnban: true,
  sendSpamStanzaOnBan: true,
  echoReportsInChat: true,
  smtpEnabled: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: process.env.SMTP_SECURE !== 'false',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  supportRecipients:
    process.env.WHATSAPP_SUPPORT_EMAILS ||
    'support@support.whatsapp.com, smb_web@support.whatsapp.com, android_web@support.whatsapp.com',
};

let templatesCache: ReportTemplate[] | null = null;
let settingsCache: ReportSettings | null = null;
let logsCache: ReportExecutionLog[] | null = null;

registerDbHydrationHook(() => {
  templatesCache = null;
  settingsCache = null;
  logsCache = null;
});

function sanitizeSettings(raw: Partial<ReportSettings> | null | undefined): ReportSettings {
  const s = raw || {};
  return {
    banRepeatCount: Math.max(1, Math.min(10, Math.floor(Number(s.banRepeatCount ?? DEFAULT_SETTINGS.banRepeatCount) || 1))),
    unbanRepeatCount: Math.max(1, Math.min(10, Math.floor(Number(s.unbanRepeatCount ?? DEFAULT_SETTINGS.unbanRepeatCount) || 1))),
    blockOnBan: typeof s.blockOnBan === 'boolean' ? s.blockOnBan : DEFAULT_SETTINGS.blockOnBan,
    unblockOnUnban:
      typeof s.unblockOnUnban === 'boolean' ? s.unblockOnUnban : DEFAULT_SETTINGS.unblockOnUnban,
    sendSpamStanzaOnBan:
      typeof s.sendSpamStanzaOnBan === 'boolean'
        ? s.sendSpamStanzaOnBan
        : DEFAULT_SETTINGS.sendSpamStanzaOnBan,
    echoReportsInChat:
      typeof s.echoReportsInChat === 'boolean'
        ? s.echoReportsInChat
        : DEFAULT_SETTINGS.echoReportsInChat,
    smtpEnabled: typeof s.smtpEnabled === 'boolean' ? s.smtpEnabled : DEFAULT_SETTINGS.smtpEnabled,
    smtpHost: typeof s.smtpHost === 'string' && s.smtpHost.trim() ? s.smtpHost.trim() : DEFAULT_SETTINGS.smtpHost,
    smtpPort: Math.max(1, Math.min(65535, Math.floor(Number(s.smtpPort ?? DEFAULT_SETTINGS.smtpPort) || 465))),
    smtpSecure: typeof s.smtpSecure === 'boolean' ? s.smtpSecure : DEFAULT_SETTINGS.smtpSecure,
    smtpUser: typeof s.smtpUser === 'string' ? s.smtpUser.trim() : DEFAULT_SETTINGS.smtpUser,
    smtpPass: typeof s.smtpPass === 'string' ? s.smtpPass : DEFAULT_SETTINGS.smtpPass,
    supportRecipients:
      typeof s.supportRecipients === 'string' && s.supportRecipients.trim()
        ? s.supportRecipients.trim()
        : DEFAULT_SETTINGS.supportRecipients,
  };
}

export const reportStore = {
  getSettings(): ReportSettings {
    if (!settingsCache) {
      const fromDb = dbGetSync<Partial<ReportSettings>>('report_settings');
      settingsCache = sanitizeSettings(fromDb);
    }
    return { ...settingsCache };
  },

  getPublicSettings(): Omit<ReportSettings, 'smtpPass'> & { hasSmtpPass: boolean } {
    const s = this.getSettings();
    const { smtpPass, ...rest } = s;
    return {
      ...rest,
      hasSmtpPass: Boolean(smtpPass && smtpPass.trim().length > 0),
    };
  },

  updateSettings(patch: Partial<ReportSettings>): ReportSettings {
    const current = this.getSettings();
    const nextPatch: Partial<ReportSettings> = { ...patch };
    // Preserve existing password if UI sends blank or masked placeholder
    if (nextPatch.smtpPass === undefined || nextPatch.smtpPass === '••••••••') {
      nextPatch.smtpPass = current.smtpPass;
    }
    const merged = sanitizeSettings({ ...current, ...nextPatch });
    settingsCache = merged;
    dbSetSync('report_settings', merged);
    return { ...merged };
  },

  listTemplates(type?: ReportActionType): ReportTemplate[] {
    if (!templatesCache) {
      const fromDb = dbGetSync<ReportTemplate[]>('report_templates') || [];
      templatesCache = Array.isArray(fromDb) ? fromDb : [];
    }
    const all = [...templatesCache];
    return type ? all.filter((t) => t.type === type) : all;
  },

  addTemplate(input: {
    type: ReportActionType;
    title?: string;
    body: string;
    enabled?: boolean;
  }): ReportTemplate {
    const list = this.listTemplates();
    const sameTypeCount = list.filter((t) => t.type === input.type).length;
    const cleanBody = String(input.body || '').trim();
    const entry: ReportTemplate = {
      id: `${input.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: input.type,
      title:
        String(input.title || '').trim() ||
        `${input.type === 'ban' ? 'Ban Report' : 'Unban Report'} #${sameTypeCount + 1}`,
      body: cleanBody,
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    templatesCache = list;
    dbSetSync('report_templates', list);
    return entry;
  },

  bulkAddTemplates(input: {
    type: ReportActionType;
    rawBlock: string;
    separator?: string;
  }): ReportTemplate[] {
    const raw = String(input.rawBlock || '').trim();
    if (!raw) return [];
    const chunks = raw
      .split(/\n\s*(?:---+|===+)\s*\n/g)
      .map((c) => c.trim())
      .filter(Boolean);
    const created: ReportTemplate[] = [];
    for (const chunk of chunks) {
      created.push(this.addTemplate({ type: input.type, body: chunk }));
    }
    return created;
  },

  updateTemplate(
    id: string,
    patch: Partial<Pick<ReportTemplate, 'title' | 'body' | 'enabled' | 'type'>>
  ): ReportTemplate | null {
    const list = this.listTemplates();
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const current = list[idx];
    const updated: ReportTemplate = {
      ...current,
      type: patch.type === 'ban' || patch.type === 'unban' ? patch.type : current.type,
      title: typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : current.title,
      body: typeof patch.body === 'string' && patch.body.trim() ? patch.body.trim() : current.body,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    };
    list[idx] = updated;
    templatesCache = list;
    dbSetSync('report_templates', list);
    return updated;
  },

  deleteTemplate(id: string): boolean {
    const list = this.listTemplates();
    const filtered = list.filter((t) => t.id !== id);
    if (filtered.length === list.length) return false;
    templatesCache = filtered;
    dbSetSync('report_templates', filtered);
    return true;
  },

  clearTemplates(type?: ReportActionType): number {
    const list = this.listTemplates();
    const next = type ? list.filter((t) => t.type !== type) : [];
    const removed = list.length - next.length;
    templatesCache = next;
    dbSetSync('report_templates', next);
    return removed;
  },

  listLogs(limit = 50): ReportExecutionLog[] {
    if (!logsCache) {
      const fromDb = dbGetSync<ReportExecutionLog[]>('report_logs') || [];
      logsCache = Array.isArray(fromDb) ? fromDb : [];
    }
    return logsCache.slice(0, limit);
  },

  addLog(entry: Omit<ReportExecutionLog, 'id' | 'timestamp'>): ReportExecutionLog {
    const list = this.listLogs(100);
    const created: ReportExecutionLog = {
      ...entry,
      id: `rep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    list.unshift(created);
    if (list.length > 100) list.length = 100;
    logsCache = list;
    dbSetSync('report_logs', list);
    return created;
  },

  clearLogs(): void {
    logsCache = [];
    dbSetSync('report_logs', []);
  },
};

export function renderReportText(
  templateBody: string,
  vars: { targetNumber: string; targetJid: string; reason?: string }
): string {
  const digits = normalizePhone(vars.targetNumber || jidUserPart(vars.targetJid)) || vars.targetNumber;
  const plusNumber = digits ? `+${digits}` : vars.targetJid;
  const dateStr = new Date().toISOString().slice(0, 10);
  const reasonText = (vars.reason || '').trim() || 'Policy violation / Urgent review requested';

  let out = templateBody
    .replace(/\{\{\s*number\s*\}\}|\{\s*number\s*\}/gi, plusNumber)
    .replace(/\{\{\s*(?:raw|digits)\s*\}\}|\{\s*(?:raw|digits)\s*\}/gi, digits)
    .replace(/\{\{\s*jid\s*\}\}|\{\s*jid\s*\}/gi, vars.targetJid)
    .replace(/\{\{\s*reason\s*\}\}|\{\s*reason\s*\}/gi, reasonText)
    .replace(/\{\{\s*date\s*\}\}|\{\s*date\s*\}/gi, dateStr)
    .trim();

  if (digits && !out.includes(digits)) {
    out = `${out}\nTarget Number: ${plusNumber}`;
  }
  return out;
}

function parseRecipientEmails(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw || '')
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )
  );
}

export async function sendTestSmtpEmail(toOverride?: string): Promise<{ ok: boolean; detail: string }> {
  const settings = reportStore.getSettings();
  if (!settings.smtpUser || !settings.smtpPass) {
    return { ok: false, detail: 'Enter SMTP email user and app password first.' };
  }
  const recipients = parseRecipientEmails(toOverride || settings.smtpUser);
  if (recipients.length === 0) {
    return { ok: false, detail: 'No valid test recipient email address.' };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      auth: {
        user: settings.smtpUser,
        pass: settings.smtpPass,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 12_000,
    });
    await transporter.sendMail({
      from: settings.smtpUser,
      to: recipients[0],
      subject: 'FADI KING MD — Report Engine SMTP Test',
      text: `SMTP connection verified at ${new Date().toISOString()}. Ban & Unban multi-report email dispatch is ready.`,
    });
    return { ok: true, detail: `Test email sent to ${recipients[0]}.` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message || 'SMTP connection failed.' };
  }
}

export async function executeMultiReport(input: {
  sock: WASocket | null;
  type: ReportActionType;
  targetNumber: string;
  targetJid: string;
  reason?: string;
  triggeredBy: string;
  chatId?: string;
  isGroup?: boolean;
  quotedMsgId?: string;
  isSimulated?: boolean;
}): Promise<ReportExecutionLog> {
  const settings = reportStore.getSettings();
  const enabledTemplates = reportStore
    .listTemplates(input.type)
    .filter((t) => t.enabled && t.body.trim().length > 0);

  const repeatCount =
    input.type === 'ban' ? settings.banRepeatCount : settings.unbanRepeatCount;

  const appliedReports: Array<{ title: string; body: string }> = [];
  const MAX_TOTAL_REPORTS = 50;

  for (let round = 0; round < repeatCount; round += 1) {
    for (const tpl of enabledTemplates) {
      if (appliedReports.length >= MAX_TOTAL_REPORTS) break;
      const rendered = renderReportText(tpl.body, {
        targetNumber: input.targetNumber,
        targetJid: input.targetJid,
        reason: input.reason,
      });
      appliedReports.push({
        title: repeatCount > 1 ? `${tpl.title} (Round ${round + 1})` : tpl.title,
        body: rendered,
      });
    }
    if (appliedReports.length >= MAX_TOTAL_REPORTS) break;
  }

  let blockActionStatus = 'Skipped';
  let spamStanzasAttempted = 0;
  let spamStanzasAccepted = 0;
  let emailsAttempted = 0;
  let emailsSent = 0;
  let emailError: string | undefined;

  const targetDigits = normalizePhone(input.targetNumber) || jidUserPart(input.targetJid);
  const targetPnJid =
    targetDigits && !input.targetJid.includes('@')
      ? `${targetDigits}@s.whatsapp.net`
      : input.targetJid || `${targetDigits}@s.whatsapp.net`;

  if (input.isSimulated || !input.sock) {
    blockActionStatus =
      input.type === 'ban'
        ? settings.blockOnBan
          ? 'Simulated Block'
          : 'Disabled'
        : settings.unblockOnUnban
          ? 'Simulated Unblock'
          : 'Disabled';
    if (input.type === 'ban' && settings.sendSpamStanzaOnBan) {
      spamStanzasAttempted = Math.max(1, Math.min(appliedReports.length || 1, 10));
      spamStanzasAccepted = spamStanzasAttempted;
    }
    if (settings.smtpEnabled && settings.smtpUser && settings.smtpPass) {
      emailsAttempted = appliedReports.length;
      emailsSent = appliedReports.length;
    }
  } else {
    // 1. WhatsApp Block / Unblock action
    if (input.type === 'ban' && settings.blockOnBan) {
      try {
        await input.sock.updateBlockStatus(targetPnJid, 'block');
        blockActionStatus = 'Blocked on WhatsApp';
      } catch (err) {
        blockActionStatus = `Block failed (${(err as Error).message})`;
      }
    } else if (input.type === 'unban' && settings.unblockOnUnban) {
      try {
        await input.sock.updateBlockStatus(targetPnJid, 'unblock');
        blockActionStatus = 'Unblocked on WhatsApp';
      } catch (err) {
        blockActionStatus = `Unblock skipped (${(err as Error).message})`;
      }
    }

    // 2. WhatsApp Protocol Spam Report IQ stanzas (on .ban)
    if (input.type === 'ban' && settings.sendSpamStanzaOnBan && typeof input.sock.query === 'function') {
      const stanzaCount = Math.max(1, Math.min(appliedReports.length || 1, 10));
      const spamFlow = input.isGroup ? 'Group' : 'Message';
      for (let i = 0; i < stanzaCount; i += 1) {
        spamStanzasAttempted += 1;
        const msgId =
          (i === 0 && input.quotedMsgId) ||
          `RPT${Date.now().toString(36).toUpperCase()}${i}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const tsSec = String(Math.floor(Date.now() / 1000) - i);
        try {
          await input.sock.query(
            {
              tag: 'iq',
              attrs: {
                to: 's.whatsapp.net',
                type: 'set',
                xmlns: 'spam',
              },
              content: [
                {
                  tag: 'spam_list',
                  attrs: {
                    spam_flow: spamFlow,
                    ...(input.isGroup && input.chatId ? { spam_source: input.chatId } : {}),
                  },
                  content: [
                    {
                      tag: 'message',
                      attrs: {
                        from: targetPnJid,
                        id: msgId,
                        t: tsSec,
                      },
                    },
                  ],
                },
              ],
            },
            3000
          );
          spamStanzasAccepted += 1;
        } catch {
          // Server may decline synthetic stanza IDs without interrupting socket stability
        }
      }
    }

    // 3. Multi-Report Support Email Dispatch (when SMTP configured in Admin Panel / env)
    if (settings.smtpEnabled && settings.smtpUser && settings.smtpPass && appliedReports.length > 0) {
      const recipients = parseRecipientEmails(settings.supportRecipients);
      if (recipients.length > 0) {
        try {
          const transporter = nodemailer.createTransport({
            host: settings.smtpHost,
            port: settings.smtpPort,
            secure: settings.smtpSecure,
            auth: {
              user: settings.smtpUser,
              pass: settings.smtpPass,
            },
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 12_000,
          });

          for (let i = 0; i < appliedReports.length; i += 1) {
            const rep = appliedReports[i];
            const toAddr = recipients[i % recipients.length];
            emailsAttempted += 1;
            const subject =
              input.type === 'ban'
                ? `WhatsApp Account Violation Report #${i + 1} — +${targetDigits}`
                : `WhatsApp Number Unban Appeal #${i + 1} — +${targetDigits}`;
            try {
              await transporter.sendMail({
                from: settings.smtpUser,
                to: toAddr,
                subject,
                text: rep.body,
              });
              emailsSent += 1;
            } catch (sendErr) {
              emailError = (sendErr as Error).message;
            }
          }
        } catch (connErr) {
          emailError = (connErr as Error).message;
        }
      }
    }
  }

  const summary = [
    `${input.type.toUpperCase()} +${targetDigits}`,
    `${appliedReports.length} report(s) applied`,
    spamStanzasAttempted > 0 ? `WA Spam IQ ${spamStanzasAccepted}/${spamStanzasAttempted}` : '',
    emailsAttempted > 0 ? `Email ${emailsSent}/${emailsAttempted}` : '',
    blockActionStatus !== 'Skipped' ? blockActionStatus : '',
  ]
    .filter(Boolean)
    .join(' · ');

  logger.security('reportEngine', summary);

  return reportStore.addLog({
    type: input.type,
    targetNumber: targetDigits,
    targetJid: targetPnJid,
    triggeredBy: input.triggeredBy,
    templateCount: enabledTemplates.length,
    totalReportsFired: appliedReports.length,
    spamStanzasAccepted,
    spamStanzasAttempted,
    emailsSent,
    emailsAttempted,
    emailError,
    blockActionStatus,
    appliedReports,
    summary,
  });
}
