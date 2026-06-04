/**
 * Buffer circular en memoria para auditar comunicacion con Ajax Cloud + AWS.
 * Pensado para diagnostico en /system tab Debug. NO se persiste a disco.
 *
 * Cada entry registra:
 *  - source: 'ajax-http' | 'sqs' | 'ajax-auth' | 'webhook'
 *  - direction: 'out' (request saliente) | 'in' (response recibido)
 *  - level: 'info' | 'warn' | 'error'
 *  - status, durationMs, sizeBytes, etc.
 *
 * Importante: NO se loguean tokens/secrets/passwords completos. Headers sensibles
 * se redactan a `***` (X-Api-Key, X-Company-Token, X-Session-Token, Authorization).
 *
 * Tambien emite por socket.io a cualquier ADMIN/OPERATOR conectado.
 */

import { logger } from './logger';

export type DebugSource = 'ajax-http' | 'ajax-auth' | 'sqs' | 'webhook';
export type DebugLevel = 'info' | 'warn' | 'error';
export type DebugDirection = 'out' | 'in' | 'event';

export interface DebugEntry {
  id: string;
  ts: number;
  source: DebugSource;
  level: DebugLevel;
  direction: DebugDirection;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  message: string;
  meta?: Record<string, unknown>;
  errorMessage?: string;
}

const MAX_ENTRIES = 500;
const buffer: DebugEntry[] = [];
let nextId = 1;

const SENSITIVE_HEADER_RE = /^(x-api-key|x-company-token|x-session-token|x-refresh-token|authorization|cookie|set-cookie)$/i;

export function redactHeaders(h: Record<string, unknown> | undefined): Record<string, string> {
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (SENSITIVE_HEADER_RE.test(k)) {
      out[k] = '***';
    } else {
      out[k] = String(v).slice(0, 200);
    }
  }
  return out;
}

export function redactUrl(url: string | undefined): string {
  if (!url) return '';
  // Ofuscar query strings con tokens
  return url.replace(/(token|key|secret)=([^&]+)/gi, '$1=***').slice(0, 300);
}

type Listener = (e: DebugEntry) => void;
const listeners = new Set<Listener>();

export function onDebugEntry(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pushDebug(e: Omit<DebugEntry, 'id' | 'ts'>): DebugEntry {
  const entry: DebugEntry = {
    id: `dbg-${nextId++}`,
    ts: Date.now(),
    ...e,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  // notify listeners (socket.io emit)
  for (const l of listeners) {
    try { l(entry); } catch (err) { /* swallow */ }
  }
  // tambien al logger pino con nivel adecuado
  if (entry.level === 'error') logger.error({ debug: entry }, entry.message);
  else if (entry.level === 'warn') logger.warn({ debug: entry }, entry.message);
  return entry;
}

export function getDebugEntries(opts: { since?: number; limit?: number; source?: string; level?: string } = {}): DebugEntry[] {
  let out = buffer;
  if (opts.since) out = out.filter((e) => e.ts >= opts.since!);
  if (opts.source) out = out.filter((e) => e.source === opts.source);
  if (opts.level) out = out.filter((e) => e.level === opts.level);
  if (opts.limit && opts.limit < out.length) out = out.slice(-opts.limit);
  return out;
}

export function clearDebugLog(): void {
  buffer.length = 0;
  pushDebug({
    source: 'ajax-http',
    level: 'info',
    direction: 'event',
    message: 'Debug log limpiado',
  });
}
