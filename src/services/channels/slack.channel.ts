import { assertSafeWebhookUrl } from './url-safety';
import axios, { AxiosError } from 'axios';
import type { AjaxEvent, WebhookSubscription } from '@prisma/client';
import { config } from '../../config';
import type { DeliveryResult } from './index';

const SEV_EMOJI: Record<string, string> = { ALARM: ':rotating_light:', WARNING: ':warning:', INFO: ':information_source:', MAINTENANCE: ':wrench:' };
const SEV_COLOR: Record<string, string> = { ALARM: '#ef4444', WARNING: '#f59e0b', INFO: '#3b82f6', MAINTENANCE: '#10b981' };

export async function dispatchSlack(event: AjaxEvent, sub: WebhookSubscription): Promise<DeliveryResult> {
  const cfg = (sub.config || {}) as Record<string, string>;
  const url = sub.url || cfg.webhookUrl;
  if (!url) return { ok: false, errorMessage: 'webhookUrl requerida para Slack' };
  const sev = (event.severity || 'INFO').toUpperCase();
  const emoji = SEV_EMOJI[sev] || ':bell:';
  const color = SEV_COLOR[sev] || '#94a3b8';
  const body = {
    username: cfg.username || 'Ajax Manager',
    icon_emoji: ':shield:',
    text: `${emoji} *${sev}* - ${event.description || event.eventCode || 'Evento Ajax'}`,
    attachments: [{
      color,
      fields: [
        { title: 'Hub', value: event.hubId || '-', short: true },
        { title: 'Codigo', value: `${event.protocol || ''} ${event.eventCode || '-'}`, short: true },
        { title: 'Severidad', value: sev, short: true },
        { title: 'Cuando', value: event.occurredAt ? new Date(event.occurredAt).toISOString() : '-', short: true },
      ],
      footer: 'AJM Ajax Manager',
      ts: Math.floor((event.occurredAt?.getTime() ?? event.receivedAt.getTime()) / 1000),
    }],
  };
  try { await assertSafeWebhookUrl(url); } catch (e) {
    return { ok: false, errorMessage: 'URL bloqueada por seguridad: ' + (e as Error).message };
  }
  try {
    const res = await axios.post(url, body, { timeout: config.WEBHOOK_TIMEOUT_MS,
      maxRedirects: 0 });
    return { ok: true, httpStatus: res.status };
  } catch (err) {
    const ax = err as AxiosError;
    return { ok: false, httpStatus: ax.response?.status, errorMessage: ax.message };
  }
}
