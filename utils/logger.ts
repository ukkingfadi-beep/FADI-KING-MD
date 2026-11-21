export type LogLevel = 'info' | 'warn' | 'error' | 'security' | 'cmd';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
}

const MAX_LOGS = 200;
const logBuffer: LogEntry[] = [];

export function formatLogDateTime(input: string | Date = new Date()): string {
  const iso = input instanceof Date ? input.toISOString() : String(input);
  return iso.slice(0, 19).replace('T', ' ');
}

function pushLog(level: LogLevel, module: string, message: string): LogEntry {
  const nowIso = new Date().toISOString();
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: nowIso,
    level,
    module,
    message,
  };
  logBuffer.unshift(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.length = MAX_LOGS;
  }

  const dateTime = formatLogDateTime(entry.timestamp);
  const tag = `[${dateTime}] [${level.toUpperCase()}] [${module}]`;
  if (level === 'error') {
    console.error(`${tag} ${message}`);
  } else {
    console.log(`${tag} ${message}`);
  }

  return entry;
}

export const logger = {
  info: (module: string, message: string) => pushLog('info', module, message),
  warn: (module: string, message: string) => pushLog('warn', module, message),
  error: (module: string, message: string) => pushLog('error', module, message),
  security: (module: string, message: string) => pushLog('security', module, message),
  cmd: (module: string, message: string) => pushLog('cmd', module, message),
  getRecent: (limit = 50): LogEntry[] => logBuffer.slice(0, limit),
  clear: (): void => {
    logBuffer.length = 0;
  },
};
