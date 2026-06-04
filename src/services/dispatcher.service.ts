import { Queue } from 'bullmq';
import { config } from '../config';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';

/**
 * Productor de jobs para el dispatcher de webhooks.
 *
 * Por cada evento procesado, encolamos UN job por subscripción que matchee
 * con los filtros (hubIds / severities / eventCodes). El consumidor real
 * (webhook-dispatcher.worker.ts) se encarga del POST con retries.
 */

export const WEBHOOK_QUEUE_NAME = 'ajax-webhook-dispatch';

export interface WebhookJobData {
  eventId: string;
  subscriptionId: string;
}

class DispatcherService {
  readonly queue: Queue<WebhookJobData>;

  constructor() {
    this.queue = new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: config.WEBHOOK_RETRY_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: config.WEBHOOK_RETRY_BACKOFF_MS,
        },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // 24h o 1000 jobs
        removeOnFail: { age: 60 * 60 * 24 * 7 }, // 7 días para inspeccionar fallos
      },
    });
  }

  /**
   * Encola un webhook por cada subscripción activa que matchee el evento.
   */
  async enqueueForEvent(eventId: string): Promise<number> {
    const event = await prisma.ajaxEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      logger.warn({ eventId }, 'enqueueForEvent: evento no existe');
      return 0;
    }

    const subs = await prisma.webhookSubscription.findMany({ where: { active: true } });
    if (subs.length === 0) return 0;

    let enqueued = 0;
    for (const sub of subs) {
      if (!matchesFilters(sub.filters, event)) continue;

      // Crear el registro de delivery en estado PENDING - útil para auditoría
      // incluso antes de que el worker lo levante.
      const delivery = await prisma.webhookDelivery.create({
        data: {
          eventId: event.id,
          subscriptionId: sub.id,
          status: 'PENDING',
        },
      });

      await this.queue.add(
        'webhook-deliver',
        { eventId: event.id, subscriptionId: sub.id },
        {
          // Job ID determinístico para evitar duplicados si reintenta el caller
          jobId: `delivery_${delivery.id}`,
        },
      );
      enqueued++;
    }

    if (enqueued > 0) {
      await prisma.ajaxEvent.update({
        where: { id: event.id },
        data: { status: 'DISPATCHED' },
      });
    }

    logger.info({ eventId, enqueued, total: subs.length }, 'Eventos encolados a webhooks');
    return enqueued;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Evalúa si un evento matchea los filtros de una subscripción.
 * Filtros soportados (todos opcionales, AND):
 *   { hubIds: string[], severities: string[], eventCodes: string[] }
 */
function matchesFilters(
  filters: unknown,
  event: { hubId: string | null; severity: string | null; eventCode: string | null },
): boolean {
  if (!filters || typeof filters !== 'object') return true;
  const f = filters as Record<string, unknown>;

  if (Array.isArray(f.hubIds) && f.hubIds.length > 0) {
    if (!event.hubId || !f.hubIds.includes(event.hubId)) return false;
  }
  if (Array.isArray(f.severities) && f.severities.length > 0) {
    if (!event.severity || !f.severities.includes(event.severity)) return false;
  }
  if (Array.isArray(f.eventCodes) && f.eventCodes.length > 0) {
    if (!event.eventCode || !f.eventCodes.includes(event.eventCode)) return false;
  }
  return true;
}

export const dispatcherService = new DispatcherService();
