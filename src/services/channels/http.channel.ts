import axios, { AxiosError } from 'axios';
import { createHmac } from 'crypto';
import type { AjaxEvent, WebhookSubscription } from '@prisma/client';
import { config } from '../../config';
import type { DeliveryResult } from './index';
import { assertSafeWebhookUrl } from './url-safety';

export async function dispatchHttp(event: AjaxEvent, sub: WebhookSubscription): Promise<DeliveryResult> {
  if (!sub.url) return { ok: false, errorMessage: 'url requerida para canal HTTP' };
  try { await assertSafeWebhookUrl(sub.url); } catch (e) {
    return { ok: false, errorMessage: 'URL bloqueada por seguridad: ' + (e as Error).message };
  }
  const body = {
    id: event.id, hubId: event.hubId, eventCode: event.eventCode,
    protocol: event.protocol, description: event.description,
    severity: event.severity, occurredAt: event.occurredAt, receivedAt: event.receivedAt,
  };
  const bodyString = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'AjaxManagerAJM/0.6',
    'X-Event-Id': event.id,
  };
  if (sub.extraHeaders && typeof sub.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(sub.extraHeaders as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  if (sub.secret) {
    const sig = createHmac('sha256', sub.secret).update(bodyString).digest('hex');
    headers['X-Ajax-Signature'] = `sha256=${sig}`;
  }
  try {
    const res = await axios.post(sub.url, bodyString, {
      headers, timeout: config.WEBHOOK_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 300,
      maxRedirects: 0,
    });
    return { ok: true, httpStatus: res.status };
  } catch (err) {
    const ax = err as AxiosError;
    return {
      ok: false,
      httpStatus: ax.response?.status,
      errorMessage: ax.message,
      responseBody: typeof ax.response?.data === 'string' ? ax.response.data.slice(0, 500) : undefined,
    };
  }
}
