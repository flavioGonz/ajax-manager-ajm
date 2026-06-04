import fs from 'fs';
import path from 'path';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * Housekeeping worker - corre todos los dias a las 03:00 hora Uruguay.
 *
 * Acciones:
 *  1) Borra AjaxEvent con protocol='AJAX_LOG' y receivedAt < now - HK_LOG_RETENTION_DAYS (default 30)
 *  2) Borra archivos en DEVICE_IMAGES_DIR con mtime < now - HK_IMAGE_RETENTION_DAYS (default 90)
 *
 * Estrategia de scheduling sin dependencias extra:
 *  - Hace tick cada 5 minutos.
 *  - Si la hora actual (en America/Montevideo) es 03:XX y no se corrio hoy, ejecuta.
 *  - Tracking de "ya corri hoy" en memoria + en Redis-less marker (timestamp.run).
 *  - Tambien expone runOnce() para gatillarlo manualmente.
 */

const TZ = 'America/Montevideo';
const TARGET_HOUR_LOCAL = Number(process.env.HK_HOUR_UYT || '3'); // hora local UYT
const TICK_MS = 5 * 60 * 1000; // cada 5 minutos
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.HK_LOG_RETENTION_DAYS || '30'));
const IMAGE_RETENTION_DAYS = Math.max(1, Number(process.env.HK_IMAGE_RETENTION_DAYS || '90'));
const DEVICE_IMAGES_DIR = process.env.DEVICE_IMAGES_DIR || '/app/data/device-images';

let _intervalHandle: NodeJS.Timeout | null = null;
let _lastRunDate = ''; // YYYY-MM-DD (en UYT) del ultimo run exitoso
let _running = false;

function todayKeyUYT(now: Date = new Date()): string {
  // YYYY-MM-DD en zona Montevideo
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value || '';
  const m = parts.find((p) => p.type === 'month')?.value || '';
  const d = parts.find((p) => p.type === 'day')?.value || '';
  return `${y}-${m}-${d}`;
}

function hourUYT(now: Date = new Date()): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hour12: false,
  }).format(now);
  return Number(s);
}

async function pruneAjaxLogs(): Promise<{ deleted: number; cutoff: Date }> {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.ajaxEvent.deleteMany({
    where: {
      protocol: 'AJAX_LOG',
      receivedAt: { lt: cutoff },
    },
  });
  return { deleted: result.count, cutoff };
}

async function pruneDeviceImages(): Promise<{ scanned: number; deleted: number; freedBytes: number; cutoff: Date }> {
  const cutoff = new Date(Date.now() - IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffMs = cutoff.getTime();
  let scanned = 0;
  let deleted = 0;
  let freedBytes = 0;
  try {
    if (!fs.existsSync(DEVICE_IMAGES_DIR)) {
      return { scanned, deleted, freedBytes, cutoff };
    }
    const entries = await fs.promises.readdir(DEVICE_IMAGES_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      // Solo tocamos fotos uploaded de eventos (NO los iconos PNG que vienen del repo).
      // Los iconos suelen ser PascalCase (MotionCam.png). Las fotos de evento usan prefijo:
      //   img-{eventId}-{idx}.{ext} o evt-{eventId}.{ext}
      if (!/^(img|evt|photo|frame)[-_]/i.test(ent.name)) continue;
      const full = path.join(DEVICE_IMAGES_DIR, ent.name);
      try {
        const st = await fs.promises.stat(full);
        scanned++;
        if (st.mtimeMs < cutoffMs) {
          freedBytes += st.size;
          await fs.promises.unlink(full);
          deleted++;
        }
      } catch (err) {
        logger.warn({ file: ent.name, err: (err as Error).message }, 'housekeeping: stat/unlink fallo');
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message, dir: DEVICE_IMAGES_DIR }, 'housekeeping: readdir fallo');
  }
  return { scanned, deleted, freedBytes, cutoff };
}

async function run(): Promise<void> {
  if (_running) {
    logger.warn('housekeeping: ya hay un run en curso, salteo');
    return;
  }
  _running = true;
  const t0 = Date.now();
  try {
    logger.info({ logDays: LOG_RETENTION_DAYS, imgDays: IMAGE_RETENTION_DAYS }, 'housekeeping: arrancando run');
    const logs = await pruneAjaxLogs();
    const imgs = await pruneDeviceImages();
    const durationMs = Date.now() - t0;
    logger.info({
      durationMs,
      ajaxLogsDeleted: logs.deleted,
      ajaxLogsCutoff: logs.cutoff.toISOString(),
      imagesScanned: imgs.scanned,
      imagesDeleted: imgs.deleted,
      bytesFreed: imgs.freedBytes,
    }, 'housekeeping: run completo');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'housekeeping: run fallo');
  } finally {
    _running = false;
    _lastRunDate = todayKeyUYT();
  }
}

function tick(): void {
  try {
    const today = todayKeyUYT();
    if (_lastRunDate === today) return; // ya corri hoy
    const h = hourUYT();
    if (h !== TARGET_HOUR_LOCAL) return; // todavia no es la hora
    // Es ~03:XX UYT y no corri hoy -> go!
    void run();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'housekeeping: tick fallo');
  }
}

export const housekeepingWorker = {
  start(): void {
    if (_intervalHandle) return;
    logger.info({
      tz: TZ,
      hourLocal: TARGET_HOUR_LOCAL,
      logRetentionDays: LOG_RETENTION_DAYS,
      imageRetentionDays: IMAGE_RETENTION_DAYS,
      deviceImagesDir: DEVICE_IMAGES_DIR,
    }, 'housekeeping worker arrancado');
    // Primer chequeo inmediato (por si arrancamos justo a las 03:xx)
    setTimeout(tick, 30_000);
    _intervalHandle = setInterval(tick, TICK_MS);
  },
  stop(): void {
    if (_intervalHandle) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
      logger.info('housekeeping worker detenido');
    }
  },
  async runOnce(): Promise<void> {
    await run();
  },
};
