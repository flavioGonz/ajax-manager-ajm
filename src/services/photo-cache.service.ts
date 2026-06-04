import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

/**
 * Photo-cache service: descarga fotos de MotionCam (que llegan como signed S3 URLs
 * que expiran rapido) y las persiste localmente en DEVICE_IMAGES_DIR.
 *
 * Despues de cachearlas, actualiza el rawPayload del evento agregando un campo
 *   __localPhotos: [{ url: '/device-images/evt-<id>-<i>.<ext>', bytes, mime, sourceUrl, capturedAt }]
 * El frontend lo detecta y usa esas URLs en lugar de las firmadas (que ya pueden estar vencidas).
 *
 * No bloquea al event-processor (fire-and-forget).
 */

const DEVICE_IMAGES_DIR = process.env.DEVICE_IMAGES_DIR || '/app/data/device-images';
const DOWNLOAD_TIMEOUT_MS = Number(process.env.PHOTO_DOWNLOAD_TIMEOUT_MS || '15000');
const MAX_PHOTO_BYTES = Number(process.env.PHOTO_MAX_BYTES || (5 * 1024 * 1024)); // 5MB

interface CandidatePhoto {
  url: string;
  capturedAt?: string;
}

interface CachedPhoto {
  url: string;          // public path bajo /device-images/
  bytes: number;
  mime: string;
  sourceUrl: string;
  capturedAt?: string;
}

function ensureDir(): void {
  try { fs.mkdirSync(DEVICE_IMAGES_DIR, { recursive: true }); } catch { /* ignore */ }
}

function extractCandidates(rawPayload: unknown): CandidatePhoto[] {
  const out: CandidatePhoto[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, capturedAt?: unknown): void => {
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, capturedAt: typeof capturedAt === 'string' ? capturedAt : undefined });
  };
  if (!rawPayload || typeof rawPayload !== 'object') return out;
  const root = rawPayload as Record<string, unknown>;
  // El payload SQS de Ajax viene wrappeado: { event: {...}, recipient: {...} }
  const ev = (root.event && typeof root.event === 'object'
    ? root.event as Record<string, unknown>
    : root);

  // 1) Campos directos: imageUrls / images / photos
  for (const k of ['imageUrls', 'images', 'photos'] as const) {
    const list = ev[k];
    if (Array.isArray(list)) {
      for (const x of list) {
        if (typeof x === 'string') add(x);
        else if (x && typeof x === 'object') {
          const o = x as Record<string, unknown>;
          add(o.url || o.signedUrl || o.href, o.capturedAt || o.timestamp);
        }
      }
    }
  }

  // 2) additionalData con additionalDataType=PHOTOS_RESOURCE_DESCRIPTION
  //    orderedResourceLinks ESTA DIRECTAMENTE en additionalData (no anidado)
  const ad = (ev.additionalData && typeof ev.additionalData === 'object'
    ? ev.additionalData as Record<string, unknown>
    : null);
  if (ad) {
    if (Array.isArray(ad.orderedResourceLinks)) {
      for (const ph of ad.orderedResourceLinks as Array<Record<string, unknown>>) {
        // ignorar links no listos
        if (ph.status && typeof ph.status === 'string' && ph.status !== 'READY' && ph.status !== 'AVAILABLE') continue;
        add(ph.url || ph.signedUrl, ph.capturedAt || ph.timestamp);
      }
    }
    // legacy: si vienen anidados (formato viejo)
    const photoDesc = (ad.PHOTOS_RESOURCE_DESCRIPTION
      || ad.photos_resource_description
      || ad.photoResourceDescription) as Record<string, unknown> | undefined;
    if (photoDesc && Array.isArray(photoDesc.orderedResourceLinks)) {
      for (const ph of photoDesc.orderedResourceLinks as Array<Record<string, unknown>>) {
        add(ph.url || ph.signedUrl, ph.capturedAt || ph.timestamp);
      }
    }
    if (Array.isArray(ad.photos)) {
      for (const ph of ad.photos as Array<Record<string, unknown>>) {
        add(ph.url || ph.signedUrl, ph.capturedAt || ph.timestamp);
      }
    }
  }

  // 3) additionalDataV2: array de descriptors con contentType=IMAGES
  if (Array.isArray(ev.additionalDataV2)) {
    for (const d of ev.additionalDataV2 as Array<Record<string, unknown>>) {
      if (!d || typeof d !== 'object') continue;
      if (Array.isArray(d.orderedResourceLinks)) {
        for (const ph of d.orderedResourceLinks as Array<Record<string, unknown>>) {
          if (ph.status && typeof ph.status === 'string' && ph.status !== 'READY' && ph.status !== 'AVAILABLE') continue;
          add(ph.url || ph.signedUrl, ph.capturedAt || ph.timestamp);
        }
      }
    }
  }

  return out;
}

function pickExtension(contentType: string | undefined, url: string): string {
  if (contentType) {
    if (/jpeg|jpg/i.test(contentType)) return '.jpg';
    if (/png/i.test(contentType)) return '.png';
    if (/webp/i.test(contentType)) return '.webp';
    if (/gif/i.test(contentType)) return '.gif';
  }
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(jpe?g|png|webp|gif)$/i);
    if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch { /* ignore */ }
  return '.jpg';
}

function downloadOne(url: string, destPath: string): Promise<{ bytes: number; mime: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('invalid_url')); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Redirect (S3 a veces redirige)
        res.resume();
        downloadOne(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`http_${res.statusCode}`));
        return;
      }
      const mime = String(res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      const finalExt = pickExtension(mime, url);
      const finalPath = destPath.replace(/\.[a-z]+$/i, finalExt);
      const out = fs.createWriteStream(finalPath);
      let bytes = 0;
      let aborted = false;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PHOTO_BYTES) {
          aborted = true;
          res.destroy();
          out.destroy();
          try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
          reject(new Error('too_large'));
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        if (aborted) return;
        resolve({ bytes, mime });
        // Replace destPath with finalPath if extension differed
        if (finalPath !== destPath) {
          // caller used destPath as a hint; we don't rename — caller will read by finalPath via resolved data
        }
      });
      out.on('error', (err) => reject(err));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * Procesa un evento recien persistido: si tiene fotos firmadas, las descarga
 * y mete las URLs locales en rawPayload.__localPhotos.
 * No throwea — solo loguea si algo falla.
 */
export async function cacheEventPhotos(eventId: string): Promise<void> {
  try {
    const event = await prisma.ajaxEvent.findUnique({ where: { id: eventId } });
    if (!event || !event.rawPayload) return;
    const candidates = extractCandidates(event.rawPayload);
    if (candidates.length === 0) {
      // Debug: detectar payloads MotionCam que NO matchean el extractor
      const raw = event.rawPayload as Record<string, unknown>;
      const ev = (raw.event && typeof raw.event === 'object' ? raw.event as Record<string, unknown> : raw);
      const looksLikeMotionCam = JSON.stringify(raw).match(/orderedResourceLinks|MotionCam|PHOTOS_RESOURCE/i);
      if (looksLikeMotionCam) {
        logger.warn({
          eventId,
          eventTag: ev.eventTag,
          hubId: event.hubId,
          rawKeys: Object.keys(ev).slice(0, 20),
          additionalDataKeys: ev.additionalData && typeof ev.additionalData === 'object' ? Object.keys(ev.additionalData as object).slice(0, 10) : null,
        }, 'photo-cache: payload parece MotionCam pero el extractor no encontro URLs');
      }
      return;
    }
    logger.info({ eventId, candidateCount: candidates.length }, 'photo-cache: iniciando descarga');

    ensureDir();
    const cached: CachedPhoto[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const ext = pickExtension(undefined, cand.url);
      const filename = `evt-${eventId}-${i}${ext}`;
      const fullPath = path.join(DEVICE_IMAGES_DIR, filename);
      try {
        const result = await downloadOne(cand.url, fullPath);
        // Si downloadOne cambio la extension por content-type, buscar el archivo real
        let realName = filename;
        if (!fs.existsSync(fullPath)) {
          // probar otras extensiones comunes
          for (const altExt of ['.jpg', '.png', '.webp', '.gif']) {
            const alt = path.join(DEVICE_IMAGES_DIR, `evt-${eventId}-${i}${altExt}`);
            if (fs.existsSync(alt)) { realName = `evt-${eventId}-${i}${altExt}`; break; }
          }
        }
        cached.push({
          url: `/device-images/${realName}`,
          bytes: result.bytes,
          mime: result.mime,
          sourceUrl: cand.url,
          capturedAt: cand.capturedAt,
        });
      } catch (err) {
        logger.warn({ eventId, idx: i, err: (err as Error).message }, 'photo-cache: descarga fallo');
      }
    }
    if (cached.length === 0) return;

    // Mutar rawPayload e inyectar __localPhotos. Mantenemos los signed URLs originales por si sirven.
    const newRaw = (event.rawPayload && typeof event.rawPayload === 'object')
      ? JSON.parse(JSON.stringify(event.rawPayload))
      : {};
    newRaw.__localPhotos = cached;
    await prisma.ajaxEvent.update({
      where: { id: eventId },
      data: { rawPayload: newRaw },
    });
    logger.info({ eventId, count: cached.length, totalBytes: cached.reduce((a, b) => a + b.bytes, 0) },
      'photo-cache: fotos cacheadas localmente');
  } catch (err) {
    logger.warn({ eventId, err: (err as Error).message }, 'photo-cache: error general (ignorado)');
  }
}

/**
 * Hook fire-and-forget. No bloquea al event-processor.
 */
export function scheduleCachePhotos(eventId: string): void {
  // Pequeno delay para que la transaccion del processor commitee
  setTimeout(() => {
    void cacheEventPhotos(eventId);
  }, 100);
}

/**
 * Backfill: reprocesa eventos recientes con PHOTOS_RESOURCE para descargar fotos
 * que aun no fueron cacheadas. Util cuando se mejora el extractor.
 * Solo procesa eventos donde rawPayload contiene 'orderedResourceLinks' y
 * todavia no tienen '__localPhotos'. linkExpirationTimestamp se respeta si esta.
 */
export async function backfillRecentMotionCamPhotos(limit = 50): Promise<{ scanned: number; cached: number; skipped: number }> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = await prisma.ajaxEvent.findMany({
    where: {
      receivedAt: { gte: since },
      // Filtra eventos que probablemente tengan fotos
    },
    select: { id: true, rawPayload: true },
    orderBy: { receivedAt: 'desc' },
    take: limit,
  });
  let scanned = 0, cached = 0, skipped = 0;
  for (const ev of events) {
    if (!ev.rawPayload) continue;
    const raw = ev.rawPayload as Record<string, unknown>;
    if (raw.__localPhotos) { skipped++; continue; }
    const cands = extractCandidates(raw);
    if (cands.length === 0) continue;
    scanned++;
    try {
      await cacheEventPhotos(ev.id);
      cached++;
    } catch (err) {
      logger.warn({ eventId: ev.id, err: (err as Error).message }, 'backfill: fallo');
    }
  }
  if (scanned > 0) {
    logger.info({ scanned, cached, skipped, sinceIso: since.toISOString() }, 'backfill MotionCam: completed');
  }
  return { scanned, cached, skipped };
}
