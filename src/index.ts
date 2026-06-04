import { startApiServer } from './api/server';
import { sqsConsumer } from './workers/sqs-consumer';
import { webhookDispatcherWorker } from './workers/webhook-dispatcher.worker';
import { demoEventsWorker } from './workers/demo-events.worker';
import { ajaxLogsWorker } from './workers/ajax-logs.worker';
import { housekeepingWorker } from './workers/housekeeping.worker';
import { backfillRecentMotionCamPhotos } from './services/photo-cache.service';
import { logger } from './utils/logger';
import { dispatcherService } from './services/dispatcher.service';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { config } from './config';
import { opcServerService } from './services/opc-server.service';
import { shutdownAllScadaOpc } from './services/channels/scada-opc.channel';

async function main(): Promise<void> {
  logger.info('Ajax Manager AJM v0.7.0 arrancando...');

  const httpServer = startApiServer();
  webhookDispatcherWorker.start();
  sqsConsumer.start();
  demoEventsWorker.start();
  ajaxLogsWorker.start();
  housekeepingWorker.start();
  // Backfill MotionCam photos para eventos recientes que el extractor viejo perdio
  setTimeout(() => {
    backfillRecentMotionCamPhotos(50).catch((err: Error) => logger.warn({ err: err.message }, 'backfill startup fallo'));
  }, 30_000);

  await opcServerService.start({
    enabled: config.OPC_ENABLED,
    port: config.OPC_PORT,
    resourcePath: config.OPC_RESOURCE_PATH,
    applicationUri: config.OPC_APPLICATION_URI,
    serverName: config.OPC_SERVER_NAME,
    username: config.OPC_USERNAME || undefined,
    password: config.OPC_PASSWORD || undefined,
  }).catch((err: Error) => logger.error({ err: err.message }, 'OPC UA Server fallo'));

  // OPC UA Client ahora vive como canal de notificacion (tipo SCADA_OPC).
  // Las conexiones se establecen lazy cuando llega un evento que matchea una sub.

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown - cerrando recursos...');
    httpServer.close(() => logger.info('HTTP/Socket server cerrado'));
    demoEventsWorker.stop();
    ajaxLogsWorker.stop();
    housekeepingWorker.stop();
    await sqsConsumer.stop();
    await webhookDispatcherWorker.stop();
    await opcServerService.stop();
    await shutdownAllScadaOpc();
    await dispatcherService.close();
    await prisma.$disconnect();
    redis.disconnect();
    logger.info('Shutdown completo. Bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: (reason as Error)?.message }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message }, 'uncaughtException - saliendo');
    process.exit(1);
  });
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'Fallo fatal en main()');
  process.exit(1);
});
