import webpush from 'web-push';
import type { AjaxEvent } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { config, hasPush } from '../config';

let _vapidConfigured = false;
function ensureVapid(): boolean {
  if (!hasPush()) return false;
  if (_vapidConfigured) return true;
  try {
    webpush.setVapidDetails(
      config.VAPID_SUBJECT,
      config.VAPID_PUBLIC_KEY as string,
      config.VAPID_PRIVATE_KEY as string,
    );
    _vapidConfigured = true;
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'VAPID setup fallo');
    return false;
  }
}

interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  image?: string;        // imagen grande (MotionCam)
  tag?: string;          // grouping
  url?: string;          // url to open on click
  eventId?: string;
  severity?: string;
  hubId?: string;
}

/**
 * Envia push a TODAS las subscripciones activas que matcheen la severidad del evento.
 * No bloquea: caller debe llamar via Promise.resolve para no bloquear el event-processor.
 */
export async function sendPushForEvent(event: AjaxEvent): Promise<{ sent: number; failed: number }> {
  if (!ensureVapid()) return { sent: 0, failed: 0 };
  const sev = (event.severity || 'INFO').toUpperCase();
  const subs = await prisma.pushSubscription.findMany({
    where: {
      active: true,
      OR: [
        { severities: { isEmpty: true } },          // sin filtro -> recibe todo
        { severities: { has: sev } },               // o match exacto
      ],
    },
  });
  if (subs.length === 0) return { sent: 0, failed: 0 };

  const raw = (event.rawPayload || {}) as Record<string, unknown>;
  const evInner = (raw.event && typeof raw.event === 'object'
    ? raw.event as Record<string, unknown>
    : raw);
  const rec = (raw.recipient && typeof raw.recipient === 'object'
    ? raw.recipient as Record<string, unknown>
    : null);
  const binding = rec && rec.bindingDetails && typeof rec.bindingDetails === 'object'
    ? rec.bindingDetails as Record<string, unknown>
    : null;
  const hubName = (typeof evInner.hubName === 'string' ? evInner.hubName : '') || event.hubId || '';
  const clientName = (binding && typeof binding.objectName === 'string'
    ? binding.objectName : '');
  const localPhotos = Array.isArray(raw.__localPhotos) ? raw.__localPhotos as Array<{ url: string }> : [];

  const SEV_EMOJI: Record<string, string> = {
    ALARM: '\u{1F6A8}', WARNING: '⚠', INFO: 'ℹ', MAINTENANCE: '\u{1F527}', UNKNOWN: '\u{1F514}',
  };
  const title = `${SEV_EMOJI[sev] || ''} ${event.description || event.eventCode || 'Evento Ajax'}`.trim();
  const body = [
    clientName && `Cliente: ${clientName}`,
    hubName && `Hub: ${hubName}`,
    typeof evInner.sourceObjectName === 'string' && `Sensor: ${evInner.sourceObjectName}`,
  ].filter(Boolean).join(' • ');

  const payload: PushPayload = {
    title,
    body: body || `Codigo: ${event.eventCode || '-'}`,
    icon: '/dashboard/icons/icon-192.png',
    badge: '/dashboard/icons/icon-192.png',
    image: localPhotos.length > 0 ? localPhotos[0].url : undefined,
    tag: `evt-${event.hubId || 'all'}`,        // mismo hub = reemplaza notif anterior
    url: `/dashboard/#/events/${event.id}`,
    eventId: event.id,
    severity: sev,
    hubId: event.hubId || undefined,
  };

  const json = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const toDisable: string[] = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, json, { TTL: 60 * 60 * 24, urgency: sev === 'ALARM' ? 'high' : 'normal' });
      sent++;
    } catch (err) {
      const e = err as { statusCode?: number; body?: string };
      const sc = e.statusCode || 0;
      failed++;
      // 410 Gone / 404 Not Found -> subscription expired -> mark inactive
      if (sc === 410 || sc === 404) {
        toDisable.push(sub.id);
      } else {
        logger.warn({ subId: sub.id, statusCode: sc, body: (e.body || '').slice(0, 200) }, 'push fallo');
      }
    }
  }));

  if (toDisable.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: toDisable } },
      data: { active: false, lastFailure: new Date(), failures: { increment: 1 } },
    });
    logger.info({ disabled: toDisable.length }, 'push: subs deshabilitadas (410/404)');
  }
  if (sent > 0) logger.info({ eventId: event.id, sent, failed, sev }, 'push notifications enviadas');
  return { sent, failed };
}

/**
 * Hook fire-and-forget para el event-processor.
 * Solo notifica ALARM/WARNING/MAINTENANCE (skip INFO por ruido).
 */
export function schedulePushForEvent(event: AjaxEvent): void {
  const sev = (event.severity || 'INFO').toUpperCase();
  if (sev === 'INFO' || sev === 'UNKNOWN') return; // no notificar INFO ni desconocidos
  setTimeout(() => {
    void sendPushForEvent(event).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'push: schedulePushForEvent fallo');
    });
  }, 50);
}

export function getVapidPublicKey(): string | null {
  return config.VAPID_PUBLIC_KEY || null;
}
