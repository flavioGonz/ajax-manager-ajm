import { Router } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { dispatcherService } from '../../services/dispatcher.service';

/**
 * Crea un router con Bull Board montado en la ruta base.
 * Hay que llamarlo despues de que el Queue de webhook-dispatch este creado.
 *
 * Lo monta el server.ts en /admin/queues (con auth de API key).
 */
export function createBullBoardRouter(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [new BullMQAdapter(dispatcherService.queue)],
    serverAdapter,
  });

  return serverAdapter.getRouter();
}
