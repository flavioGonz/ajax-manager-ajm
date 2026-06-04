import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';
import { emitEventNew } from '../realtime/socket';
import { dispatcherService } from '../services/dispatcher.service';

/**
 * Modo demo: genera 1 evento sintetico cada DEMO_INTERVAL_SEC segundos
 * para probar el flow live sin necesidad de SQS real.
 *
 * Solo arranca si DEMO_MODE=true en .env.
 */

const HUBS = [
  { id: 'HUB-IES-001', name: 'Sitio Demo Pocitos' },
  { id: 'HUB-IES-002', name: 'Sitio Demo Centro' },
  { id: 'HUB-IES-003', name: 'Sitio Demo Carrasco' },
  { id: 'HUB-IES-004', name: 'Sitio Demo Industrial' },
  { id: 'HUB-IES-005', name: 'Sitio Demo Punta del Este' },
];

const TPLS: Array<[string, string, string, string]> = [
  ['130', 'CID', 'Intrusion detectada', 'ALARM'],
  ['110', 'CID', 'Alarma de incendio', 'ALARM'],
  ['120', 'CID', 'Panico (atraco)', 'ALARM'],
  ['113', 'CID', 'Inundacion', 'ALARM'],
  ['301', 'CID', 'Perdida de alimentacion AC', 'WARNING'],
  ['302', 'CID', 'Bateria baja del panel', 'WARNING'],
  ['384', 'CID', 'Bateria baja sensor RF', 'WARNING'],
  ['356', 'CID', 'Perdida de polling', 'WARNING'],
  ['401', 'CID', 'Armado/desarmado por usuario', 'INFO'],
  ['406', 'CID', 'Cancelacion de alarma', 'INFO'],
  ['602', 'CID', 'Test periodico', 'MAINTENANCE'],
  ['BA', 'SIA', 'Burglary Alarm - Intrusion', 'ALARM'],
  ['FA', 'SIA', 'Fire Alarm - Incendio', 'ALARM'],
  ['AT', 'SIA', 'AC Trouble', 'WARNING'],
  ['OP', 'SIA', 'Opening - Desarmado', 'INFO'],
  ['CL', 'SIA', 'Closing - Armado', 'INFO'],
  ['RP', 'SIA', 'Automatic Test', 'MAINTENANCE'],
];

const W: Record<string, number> = { ALARM: 0.10, WARNING: 0.20, INFO: 0.45, MAINTENANCE: 0.25 };

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function pickByWeight(): [string, string, string, string] {
  const r = Math.random();
  let acc = 0;
  for (const sev of Object.keys(W)) {
    acc += W[sev];
    if (r <= acc) {
      const cands = TPLS.filter((t) => t[3] === sev);
      return pick(cands);
    }
  }
  return pick(TPLS);
}

export class DemoEventsWorker {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (!config.DEMO_MODE) {
      logger.info('DemoEventsWorker: deshabilitado (DEMO_MODE=false)');
      return;
    }
    logger.info({ intervalSec: config.DEMO_INTERVAL_SEC }, 'DemoEventsWorker arrancado - generando eventos sinteticos');
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private scheduleNext(): void {
    // Jitter: +/- 30% del intervalo para que se sienta organico
    const base = config.DEMO_INTERVAL_SEC * 1000;
    const jitter = base * (Math.random() * 0.6 - 0.3);
    this.timer = setTimeout(() => this.tick().finally(() => this.scheduleNext()), Math.max(2000, base + jitter));
  }

  private async tick(): Promise<void> {
    try {
      const tpl = pickByWeight();
      const hub = pick(HUBS);
      const now = new Date();
      const event = await prisma.ajaxEvent.create({
        data: {
          sqsMessageId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          messageGroupId: hub.id,
          ajaxEventId: `evt-${Math.random().toString(36).slice(2, 12)}`,
          hubId: hub.id,
          eventCode: tpl[0],
          protocol: tpl[1],
          description: tpl[2],
          severity: tpl[3],
          occurredAt: now,
          receivedAt: now,
          rawPayload: { demo: true, hubName: hub.name, code: tpl[0], protocol: tpl[1] },
          status: 'PROCESSED',
          processedAt: now,
        },
      });

      emitEventNew({
        id: event.id,
        sqsMessageId: event.sqsMessageId,
        hubId: event.hubId,
        eventCode: event.eventCode,
        protocol: event.protocol,
        description: event.description,
        severity: event.severity,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        status: event.status,
      });

      // Encolar webhooks tambien para que se vean los deliveries
      await dispatcherService.enqueueForEvent(event.id).catch(() => {/* ignore */});

      logger.debug({ id: event.id, sev: tpl[3], code: tpl[0] }, 'DEMO event generated');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'DemoEventsWorker tick fallo');
    }
  }
}

export const demoEventsWorker = new DemoEventsWorker();
