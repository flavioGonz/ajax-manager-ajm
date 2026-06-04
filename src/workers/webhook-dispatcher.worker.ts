import { Worker, Job } from 'bullmq';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { WEBHOOK_QUEUE_NAME, WebhookJobData } from '../services/dispatcher.service';
import { emitDeliveryUpdate } from '../realtime/socket';
import { dispatchByChannel } from '../services/channels';

export class WebhookDispatcherWorker {
  private worker: Worker<WebhookJobData> | null = null;

  start(): void {
    this.worker = new Worker<WebhookJobData>(
      WEBHOOK_QUEUE_NAME,
      async (job) => this.handleJob(job),
      { connection: redis, concurrency: 10 },
    );
    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, attempts: job.attemptsMade }, 'Webhook entregado correctamente');
    });
    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'Webhook fallo');
    });
    logger.info('WebhookDispatcherWorker arrancado');
  }

  async stop(): Promise<void> {
    if (this.worker) { await this.worker.close(); this.worker = null; }
  }

  private async handleJob(job: Job<WebhookJobData>): Promise<void> {
    const { eventId, subscriptionId } = job.data;
    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);

    const [event, subscription] = await Promise.all([
      prisma.ajaxEvent.findUnique({ where: { id: eventId } }),
      prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } }),
    ]);
    if (!event || !subscription) {
      throw new Error(`Evento (${eventId}) o subscripcion (${subscriptionId}) no encontrado - job descartado`);
    }
    if (!subscription.active) {
      logger.info({ subscriptionId }, 'Subscripcion inactiva - job descartado');
      return;
    }

    const deliveryId = job.id?.match(/^delivery[:_]([0-9a-fA-F-]{36})/)?.[1] ?? null;
    const startedAt = new Date();
    if (deliveryId) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'IN_PROGRESS', attempt: job.attemptsMade + 1, startedAt },
      });
    }

    const result = await dispatchByChannel(event, subscription);

    if (result.ok) {
      if (deliveryId) {
        await prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'SUCCEEDED', httpStatus: result.httpStatus ?? null, responseBody: result.responseBody ?? null, completedAt: new Date() },
        });
      }
      emitDeliveryUpdate({ id: deliveryId, eventId, subscriptionId, status: 'SUCCEEDED', httpStatus: result.httpStatus ?? null, attempt: job.attemptsMade + 1 });
    } else {
      if (deliveryId) {
        await prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: isLastAttempt ? 'DEAD_LETTER' : 'FAILED',
            httpStatus: result.httpStatus ?? null,
            errorMessage: result.errorMessage ?? null,
            responseBody: result.responseBody ?? null,
            completedAt: isLastAttempt ? new Date() : null,
          },
        });
      }
      emitDeliveryUpdate({ id: deliveryId, eventId, subscriptionId, status: isLastAttempt ? 'DEAD_LETTER' : 'FAILED', httpStatus: result.httpStatus ?? null, attempt: job.attemptsMade + 1, errorMessage: result.errorMessage });
      throw new Error(result.errorMessage || 'dispatch failed');
    }
  }
}

export const webhookDispatcherWorker = new WebhookDispatcherWorker();

if (require.main === module) {
  webhookDispatcherWorker.start();
  const shutdown = async () => { await webhookDispatcherWorker.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
