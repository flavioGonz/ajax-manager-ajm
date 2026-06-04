import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { processSqsMessage } from '../services/event-processor.service';
import { pushDebug } from '../utils/debug-log';

/**
 * Worker que consume la cola FIFO `ajax-events-*-prod.fifo` con Long Polling.
 *
 * Garantías importantes para colas FIFO:
 *  - Procesamos UN mensaje por MessageGroupId a la vez (lo respeta SQS solo si
 *    DeleteMessage llega antes del próximo ReceiveMessage del mismo grupo).
 *  - DeleteMessage SE LLAMA SOLO si el procesamiento (incluyendo persistencia y
 *    encolado de webhooks) terminó OK. Si falla, dejamos que SQS lo vuelva a
 *    entregar tras el visibility timeout.
 */
export class SqsConsumer {
  private readonly client: SQSClient;
  private running = false;

  constructor() {
    this.client = new SQSClient({
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  start(): void {
    if (this.running) {
      logger.warn('SqsConsumer ya está corriendo');
      return;
    }
    this.running = true;
    logger.info({ queueUrl: maskUrl(config.SQS_URL) }, 'SQS consumer arrancando');
    void this.loop();
  }

  async stop(): Promise<void> {
    logger.info('SQS consumer deteniéndose...');
    this.running = false;
    // No llamamos client.destroy() aquí para permitir que la iteración en curso
    // termine de procesar/borrar antes de cerrar. El graceful shutdown del index
    // espera unos segundos.
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.receiveBatch();
        if (messages.length === 0) {
          // Long polling ya esperó SQS_WAIT_TIME_SECONDS — seguimos
          continue;
        }

        // Procesamos cada mensaje secuencialmente para preservar orden FIFO
        // dentro de un grupo. Si querés más throughput entre grupos podrías
        // agruparlos por MessageGroupId y procesar grupos en paralelo.
        for (const msg of messages) {
          const ok = await processSqsMessage(msg);
          if (ok) {
            await this.deleteMessage(msg);
          } else {
            logger.warn(
              { messageId: msg.MessageId },
              'Mensaje no procesado — quedará visible para reintento',
            );
          }
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Error en loop SQS — reintentando en 5s');
        await sleep(5000);
      }
    }
    logger.info('SQS consumer loop finalizado');
  }

  private async receiveBatch(): Promise<Message[]> {
    const cmd = new ReceiveMessageCommand({
      QueueUrl: config.SQS_URL,
      MaxNumberOfMessages: config.SQS_MAX_MESSAGES,
      WaitTimeSeconds: config.SQS_WAIT_TIME_SECONDS, // long polling
      VisibilityTimeout: config.SQS_VISIBILITY_TIMEOUT,
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    });
    const start = Date.now();
    try {
      const res = await this.client.send(cmd);
      const msgs = res.Messages ?? [];
      pushDebug({
        source: 'sqs',
        level: 'info',
        direction: 'in',
        method: 'ReceiveMessage',
        url: maskUrl(config.SQS_URL),
        durationMs: Date.now() - start,
        message: `ReceiveMessage long-poll → ${msgs.length} mensaje(s)`,
        meta: { count: msgs.length, waitSec: config.SQS_WAIT_TIME_SECONDS, batchMax: config.SQS_MAX_MESSAGES },
      });
      return msgs;
    } catch (err) {
      pushDebug({
        source: 'sqs',
        level: 'error',
        direction: 'in',
        method: 'ReceiveMessage',
        url: maskUrl(config.SQS_URL),
        durationMs: Date.now() - start,
        message: `ReceiveMessage falló: ${(err as Error).name}`,
        errorMessage: (err as Error).message,
        meta: { errorName: (err as Error).name },
      });
      throw err;
    }
  }

  private async deleteMessage(msg: Message): Promise<void> {
    if (!msg.ReceiptHandle) return;
    const start = Date.now();
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: config.SQS_URL,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
      pushDebug({
        source: 'sqs',
        level: 'info',
        direction: 'out',
        method: 'DeleteMessage',
        durationMs: Date.now() - start,
        message: `DeleteMessage → ack ${msg.MessageId?.slice(0,8)}`,
        meta: { messageId: msg.MessageId, groupId: msg.Attributes?.MessageGroupId },
      });
    } catch (err) {
      // Si esto falla el mensaje volverá a aparecer y se procesará de nuevo;
      // por eso processSqsMessage debe ser idempotente (upsert).
      logger.error(
        { err: (err as Error).message, messageId: msg.MessageId },
        'Falló DeleteMessage — el mensaje será re-entregado',
      );
      pushDebug({
        source: 'sqs',
        level: 'error',
        direction: 'out',
        method: 'DeleteMessage',
        message: `DeleteMessage falló: ${(err as Error).name}`,
        errorMessage: (err as Error).message,
        meta: { messageId: msg.MessageId },
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function maskUrl(url: string): string {
  // No imprimimos el accountId completo en logs
  return url.replace(/\/\d{12}\//, '/***/');
}

export const sqsConsumer = new SqsConsumer();

// Permite arrancar el worker standalone: `npm run dev:worker`
if (require.main === module) {
  sqsConsumer.start();

  process.on('SIGINT', async () => {
    await sqsConsumer.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await sqsConsumer.stop();
    process.exit(0);
  });
}
