import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { ajaxCloudService } from '../services/ajax-cloud.service';
import { hasCompanyAuth } from '../config';
import { emitEventNew } from '../realtime/socket';
import { schedulePushForEvent } from '../services/push.service';
import { dispatcherService } from '../services/dispatcher.service';
import { scheduleCachePhotos } from '../services/photo-cache.service';

/**
 * Worker periódico que ingesta eventos del historial de cada hub Ajax (/logs)
 * y los persiste en la tabla `ajax_events` con deduplicación por `ajaxEventId`.
 *
 * Esto permite que el dashboard muestre eventos reales sin depender del
 * translatorChannelState (que activa SQS) mientras Ajax no lo habilite.
 *
 * Estrategia:
 *  - Cada `intervalSec` (default 60s), itera todos los hubs Company API.
 *  - Para cada hub: pide los últimos 50 eventos (`pageSize=50&pageIndex=0`).
 *  - Filtra los que ya existen (por ajaxEventId) y persiste solo nuevos.
 *  - Emite los nuevos via socket.io (mismo channel que SQS).
 *  - Concurrency limitada (3 hubs en paralelo) para respetar rate-limit 100/min Ajax.
 */

const INTERVAL_SEC = Number(process.env.AJAX_LOGS_POLL_SEC || '60');
const PAGE_SIZE = Math.min(100, Number(process.env.AJAX_LOGS_PAGE_SIZE || '50'));
const CONCURRENCY = Math.min(5, Number(process.env.AJAX_LOGS_CONCURRENCY || '3'));

interface AjaxLogEntry {
  eventId?: string;
  hubId?: string;
  hubName?: string;
  eventType?: string;
  eventCode?: string;
  sourceObjectType?: string;
  sourceObjectId?: string;
  sourceObjectName?: string;
  sourceRoomId?: string | null;
  sourceRoomName?: string;
  timestamp?: number;
  eventTag?: string;
  transition?: string;
  additionalData?: unknown;
  eventSource?: string;
}

/**
 * Traduce un eventTag de Ajax a severity AJM y descripción ES.
 * Ajax usa códigos propios (ej. M_22_01) + eventTag textual (Arm/MotionDetected/etc).
 */
const AJAX_TAG_MAP: Record<string, { severity: 'ALARM' | 'WARNING' | 'INFO' | 'MAINTENANCE'; description: string }> = {
  // === ALARMAS CRÍTICAS ===
  PanicAlarm:                { severity: 'ALARM',       description: 'Pánico' },
  PanicButtonPressed:        { severity: 'ALARM',       description: 'Botón de pánico presionado' },
  FireAlarm:                 { severity: 'ALARM',       description: 'Alarma de incendio' },
  SmokeDetected:             { severity: 'ALARM',       description: 'Humo detectado' },
  GasAlarm:                  { severity: 'ALARM',       description: 'Alarma de gas' },
  LeakageDetected:           { severity: 'ALARM',       description: 'Fuga / inundación detectada' },
  BurglaryAlarm:             { severity: 'ALARM',       description: 'Alarma de intrusión' },
  IntrusionAlarm:            { severity: 'ALARM',       description: 'Alarma de intrusión' },
  AlarmConfirmed:            { severity: 'ALARM',       description: 'Alarma confirmada' },
  GlassBreakDetected:        { severity: 'ALARM',       description: 'Rotura de vidrio detectada' },
  ShockDetected:             { severity: 'ALARM',       description: 'Impacto detectado' },
  HoldUpAlarm:               { severity: 'ALARM',       description: 'Pánico silencioso' },
  DuressAlarm:               { severity: 'ALARM',       description: 'Coacción' },

  // === WARNINGS (anomalías) ===
  Tampered:                  { severity: 'WARNING',     description: 'Tamper disparado' },
  TamperOpened:              { severity: 'WARNING',     description: 'Tamper abierto' },
  TamperClosed:              { severity: 'INFO',        description: 'Tamper cerrado' },
  TamperRestored:            { severity: 'INFO',        description: 'Tamper restaurado' },
  MaskingDetected:           { severity: 'WARNING',     description: 'Detector enmascarado' },
  MaskingDetectedLeft:       { severity: 'WARNING',     description: 'Enmascarado (lente izquierdo)' },
  MaskingDetectedRight:      { severity: 'WARNING',     description: 'Enmascarado (lente derecho)' },
  RFJamming:                 { severity: 'WARNING',     description: 'Interferencia RF (jamming)' },
  PowerLoss:                 { severity: 'WARNING',     description: 'Pérdida de alimentación' },
  ExternalPowerLoss:         { severity: 'WARNING',     description: 'Pérdida de alimentación externa' },
  PowerRestored:             { severity: 'INFO',        description: 'Alimentación restaurada' },
  ExternalPowerRestored:     { severity: 'INFO',        description: 'Alimentación externa restaurada' },
  BatteryLow:                { severity: 'WARNING',     description: 'Batería baja' },
  PowerLow:                  { severity: 'WARNING',     description: 'Batería baja' },
  BatteryOk:                 { severity: 'INFO',        description: 'Batería OK' },
  ConnectionLost:            { severity: 'WARNING',     description: 'Conexión perdida' },
  ConnectionRestored:        { severity: 'INFO',        description: 'Conexión restaurada' },
  DeviceCommunicationLoss:   { severity: 'WARNING',     description: 'Dispositivo sin comunicación' },
  DeviceCommunicationRestored: { severity: 'INFO',      description: 'Comunicación restaurada' },
  ServerConnectionLoss:      { severity: 'WARNING',     description: 'Pérdida de conexión con servidor' },
  ServerConnectionRestored:  { severity: 'INFO',        description: 'Conexión con servidor restaurada' },
  EthernetCommunicationLoss: { severity: 'WARNING',     description: 'Ethernet sin comunicación' },
  EthernetCommunicationRestored: { severity: 'INFO',    description: 'Ethernet restaurado' },
  GsmCommunicationLoss:      { severity: 'WARNING',     description: 'GSM sin comunicación' },
  GsmCommunicationRestored:  { severity: 'INFO',        description: 'GSM restaurado' },
  WifiCommunicationLoss:     { severity: 'WARNING',     description: 'WiFi sin comunicación' },
  WifiCommunicationRestored: { severity: 'INFO',        description: 'WiFi restaurado' },
  DataChannelCommunicationLoss: { severity: 'WARNING',  description: 'Canal de datos sin comunicación' },
  DataChannelCommunicationRestored: { severity: 'INFO', description: 'Canal de datos restaurado' },
  Offline:                   { severity: 'WARNING',     description: 'Dispositivo offline' },
  Online:                    { severity: 'INFO',        description: 'Dispositivo online' },
  Malfunction:               { severity: 'WARNING',     description: 'Malfunción' },
  IncorrectDeviceInstallation: { severity: 'WARNING',   description: 'Instalación incorrecta del dispositivo' },
  DeviceMoved:               { severity: 'WARNING',     description: 'Dispositivo movido' },

  // === OPERACIÓN NORMAL (INFO) ===
  Arm:                       { severity: 'INFO',        description: 'Armado' },
  Disarm:                    { severity: 'INFO',        description: 'Desarmado' },
  GroupArm:                  { severity: 'INFO',        description: 'Grupo armado' },
  GroupDisarm:               { severity: 'INFO',        description: 'Grupo desarmado' },
  ArmInNightMode:            { severity: 'INFO',        description: 'Armado en modo noche' },
  DisarmNightMode:           { severity: 'INFO',        description: 'Salida modo noche' },
  NightModeOn:               { severity: 'INFO',        description: 'Modo noche activado' },
  NightModeOff:              { severity: 'INFO',        description: 'Modo noche desactivado' },
  MotionDetected:            { severity: 'INFO',        description: 'Movimiento detectado' },
  MotionDetectedLeft:        { severity: 'INFO',        description: 'Movimiento detectado (izquierda)' },
  MotionDetectedRight:       { severity: 'INFO',        description: 'Movimiento detectado (derecha)' },
  DoorOpened:                { severity: 'INFO',        description: 'Puerta abierta' },
  DoorClosed:                { severity: 'INFO',        description: 'Puerta cerrada' },
  OpeningDetected:           { severity: 'INFO',        description: 'Apertura detectada' },
  ClosingDetected:           { severity: 'INFO',        description: 'Cierre detectado' },
  ExtContactOpened:          { severity: 'INFO',        description: 'Contacto externo abierto' },
  ExtContactClosed:          { severity: 'INFO',        description: 'Contacto externo cerrado' },
  RelayOnByUser:             { severity: 'INFO',        description: 'Relé activado por usuario' },
  RelayOffByUser:            { severity: 'INFO',        description: 'Relé desactivado por usuario' },
  RelayOnByArming:           { severity: 'INFO',        description: 'Relé activado por armado' },
  RelayOnByDisarming:        { severity: 'INFO',        description: 'Relé activado por desarmado' },
  RelayOnByScenario:         { severity: 'INFO',        description: 'Relé activado por escenario' },
  TurnOn:                    { severity: 'INFO',        description: 'Encendido' },
  TurnOff:                   { severity: 'INFO',        description: 'Apagado' },
  ValveOpenedByUser:         { severity: 'INFO',        description: 'Válvula abierta por usuario' },
  ValveClosedByUser:         { severity: 'INFO',        description: 'Válvula cerrada por usuario' },
  BypassOn:                  { severity: 'INFO',        description: 'Bypass activado' },
  BypassOff:                 { severity: 'INFO',        description: 'Bypass desactivado' },
  OnetimeFullBypassOn:       { severity: 'INFO',        description: 'Bypass único activado' },
  PasswordAttempt:           { severity: 'INFO',        description: 'Intento de password' },
  MonitoringStarted:         { severity: 'INFO',        description: 'Monitoreo iniciado' },
  MonitoringStopped:         { severity: 'INFO',        description: 'Monitoreo detenido' },
  ObjectAdded:               { severity: 'INFO',        description: 'Objeto agregado' },
  ObjectRemoved:             { severity: 'INFO',        description: 'Objeto removido' },

  // === MANTENIMIENTO ===
  Test:                      { severity: 'MAINTENANCE', description: 'Test del sistema' },
  FirmwareUpdated:           { severity: 'MAINTENANCE', description: 'Firmware actualizado' },
  FirmwareUpdateInProgress:  { severity: 'MAINTENANCE', description: 'Actualización de firmware en curso' },
  DevFWUpgradeStarted:       { severity: 'MAINTENANCE', description: 'Actualización firmware iniciada' },
  DevFWUpgradeFinished:      { severity: 'MAINTENANCE', description: 'Actualización firmware terminada' },
  ConfigChanged:             { severity: 'MAINTENANCE', description: 'Configuración modificada' },
  SmokeChamberTestPassed:    { severity: 'MAINTENANCE', description: 'Test cámara de humo OK' },
  SmokeChamberTestFailed:    { severity: 'WARNING',     description: 'Test cámara de humo FALLÓ' },
  CoTestPassed:              { severity: 'MAINTENANCE', description: 'Test sensor CO OK' },
  CoTestFailed:              { severity: 'WARNING',     description: 'Test sensor CO FALLÓ' },
};

function mapAjaxTag(tag: string | undefined): { severity: 'ALARM' | 'WARNING' | 'INFO' | 'MAINTENANCE' | 'UNKNOWN'; description: string } {
  const trimmed = (tag || '').trim();
  const m = AJAX_TAG_MAP[trimmed];
  if (m) return m;
  return { severity: 'UNKNOWN', description: trimmed || 'Evento desconocido' };
}

async function ingestHubLogs(hubId: string, hubName: string | undefined): Promise<{ ingested: number; errors: number }> {
  try {
    const logs = (await ajaxCloudService.getHubLogs(hubId, PAGE_SIZE, 0)) as AjaxLogEntry[];
    if (!Array.isArray(logs) || logs.length === 0) return { ingested: 0, errors: 0 };

    // Idempotencia: buscar cuáles eventIds ya existen
    const eventIds = logs.map((l) => l.eventId).filter((x): x is string => !!x);
    if (eventIds.length === 0) return { ingested: 0, errors: 0 };
    const existing = await prisma.ajaxEvent.findMany({
      where: { ajaxEventId: { in: eventIds } },
      select: { ajaxEventId: true },
    });
    const existingSet = new Set(existing.map((e) => e.ajaxEventId));
    const newOnes = logs.filter((l) => l.eventId && !existingSet.has(l.eventId));
    if (newOnes.length === 0) return { ingested: 0, errors: 0 };

    let ok = 0;
    let err = 0;
    for (const e of newOnes) {
      try {
        const { severity, description } = mapAjaxTag(e.eventTag);
        const occurredAt = e.timestamp ? new Date(e.timestamp * 1000) : null;
        const created = await prisma.ajaxEvent.create({
          data: {
            // Usamos un prefijo "ajax-log-" para diferenciar de eventos SQS
            sqsMessageId: `ajax-log-${e.eventId}`,
            ajaxEventId: e.eventId,
            hubId: e.hubId || hubId,
            eventCode: e.eventCode || null,
            protocol: 'AJAX_LOG',
            description: e.sourceObjectName ? `${description} · ${e.sourceObjectName}` : description,
            severity,
            occurredAt,
            rawPayload: e as unknown as object,
            status: 'PROCESSED',
            processedAt: new Date(),
          },
        });
        // Notificar via socket
        try {
          emitEventNew({
            id: created.id,
            sqsMessageId: created.sqsMessageId,
            hubId: created.hubId,
            eventCode: created.eventCode,
            protocol: created.protocol,
            description: created.description,
            severity: created.severity,
            occurredAt: created.occurredAt,
            receivedAt: created.receivedAt,
            status: created.status,
          });
        } catch { /* ignore socket errors */ }
        try { schedulePushForEvent(created); } catch { /* ignore */ }
        // Cachear fotos MotionCam si vienen en el log (a veces Ajax incluye orderedResourceLinks)
        try { scheduleCachePhotos(created.id); } catch { /* ignore */ }
        // Encolar tambien a webhooks (Telegram/Email/Slack) - como hace el event-processor SQS
        try { await dispatcherService.enqueueForEvent(created.id); } catch (e) { logger.warn({ eventId: created.id, err: (e as Error).message }, 'ajax-logs: enqueue dispatch fallo'); }
        ok++;
      } catch (insertErr) {
        err++;
        const msg = (insertErr as Error).message;
        if (!msg.includes('Unique constraint')) {
          logger.warn({ hubId, eventId: e.eventId, err: msg }, 'AjaxLogsIngestor: insert error');
        }
      }
    }
    if (ok > 0) logger.info({ hubId, hubName, ingested: ok }, 'AjaxLogsIngestor: nuevos eventos ingresados');
    return { ingested: ok, errors: err };
  } catch (err) {
    return { ingested: 0, errors: 1 };
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (it: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

let _intervalHandle: NodeJS.Timeout | null = null;
let _running = false;

async function tick(): Promise<void> {
  if (_running) {
    logger.debug('AjaxLogsIngestor: tick previo todavía corriendo, salteo');
    return;
  }
  if (!hasCompanyAuth) return;
  _running = true;
  const t0 = Date.now();
  let totalIngested = 0;
  let hubsProcessed = 0;
  try {
    const { data: hubs } = await ajaxCloudService.listHubs();
    if (!Array.isArray(hubs) || hubs.length === 0) return;
    await mapLimit(hubs, CONCURRENCY, async (h) => {
      hubsProcessed++;
      const r = await ingestHubLogs(h.hubId, h.name);
      totalIngested += r.ingested;
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'AjaxLogsIngestor: tick error');
  } finally {
    _running = false;
    const ms = Date.now() - t0;
    if (totalIngested > 0 || hubsProcessed > 0) {
      logger.info({ hubsProcessed, totalIngested, durationMs: ms }, 'AjaxLogsIngestor: tick completed');
    }
  }
}

export const ajaxLogsWorker = {
  start(): void {
    if (_intervalHandle) return;
    if (!hasCompanyAuth) {
      logger.info('AjaxLogsIngestor: deshabilitado (Company API no configurada)');
      return;
    }
    logger.info({ intervalSec: INTERVAL_SEC, pageSize: PAGE_SIZE, concurrency: CONCURRENCY }, 'AjaxLogsIngestor arrancado');
    // Primer tick tras 15s (dar tiempo a que el resto del sistema arranque)
    _intervalHandle = setInterval(() => void tick(), INTERVAL_SEC * 1000);
  },
  stop(): void {
    if (_intervalHandle) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
      logger.info('AjaxLogsIngestor detenido');
    }
  },
  async runOnce(): Promise<void> {
    await tick();
  },
};
