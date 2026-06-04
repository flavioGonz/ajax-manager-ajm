import { Router, Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { requireAdmin } from '../middlewares/auth.middleware';
import { logger } from '../../utils/logger';

/**
 * Endpoints para gestionar minifotos (PNG transparente) por modelo de dispositivo Ajax.
 *
 * Storage: filesystem en /app/data/device-images/{deviceType}.png.
 * El directorio /app/data/ esta bind-mounted desde /opt/ajax-manager/data/ del LXC
 * para que las imagenes persistan tras rebuild/recreate del container.
 *
 * Auth: solo Admin puede subir/borrar. Listado es publico (lo necesita el frontend
 * para decidir si usar imagen o icono lucide de fallback).
 *
 * Tamaño max: 256KB por imagen (suficiente para PNG pequeño con transparencia).
 */

const IMG_DIR = process.env.DEVICE_IMAGES_DIR || '/app/data/device-images';
const MAX_BYTES = 256 * 1024;

function ensureDir(): void {
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function safeType(t: string): string | null {
  if (!t) return null;
  // Solo permitimos caracteres alfanumericos y underscores (los deviceType de Ajax)
  if (!/^[A-Za-z0-9_]{1,64}$/.test(t)) return null;
  return t;
}

const router: Router = Router();

// GET /api/system/device-images → listado de deviceTypes que tienen imagen disponible
router.get('/', async (_req, res) => {
  ensureDir();
  try {
    const files = await fs.promises.readdir(IMG_DIR);
    const available = files
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace(/\.png$/, ''));
    res.json({ data: available, dir: IMG_DIR });
  } catch (err) {
    res.json({ data: [], dir: IMG_DIR, error: (err as Error).message });
  }
});

// POST /api/system/device-images/:type
// Body: { data: 'data:image/png;base64,...' } o { base64: '...', mime: 'image/png' }
router.post('/:type', requireAdmin, async (req: Request, res) => {
  ensureDir();
  const type = safeType(String(req.params.type || ''));
  if (!type) return res.status(400).json({ error: 'invalid_device_type' });
  const body = req.body as { data?: string; base64?: string; mime?: string };
  let b64 = body.base64 || '';
  if (!b64 && body.data) {
    // data URI: data:image/png;base64,XXXX
    const m = /^data:image\/(?:png|webp);base64,(.+)$/.exec(body.data);
    if (!m) return res.status(400).json({ error: 'invalid_data_uri', hint: 'use data:image/png;base64,...' });
    b64 = m[1];
  }
  if (!b64) return res.status(400).json({ error: 'missing_image_data' });
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  if (buf.length === 0) return res.status(400).json({ error: 'empty_image' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'image_too_large', maxBytes: MAX_BYTES });
  // Magic bytes basico: PNG signature \x89PNG\r\n\x1a\n
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return res.status(400).json({ error: 'not_a_png' });
  }
  const filePath = path.join(IMG_DIR, `${type}.png`);
  try {
    await fs.promises.writeFile(filePath, buf);
    logger.info({ type, bytes: buf.length, by: req.user?.sub }, 'Device image upload');
    return res.json({ ok: true, type, bytes: buf.length, url: `/device-images/${type}.png` });
  } catch (err) {
    return res.status(500).json({ error: 'write_failed', message: (err as Error).message });
  }
});

// DELETE /api/system/device-images/:type
router.delete('/:type', requireAdmin, async (req: Request, res) => {
  const type = safeType(String(req.params.type || ''));
  if (!type) return res.status(400).json({ error: 'invalid_device_type' });
  const filePath = path.join(IMG_DIR, `${type}.png`);
  try {
    await fs.promises.unlink(filePath);
    logger.info({ type, by: req.user?.sub }, 'Device image deleted');
    return res.json({ ok: true, type });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'delete_failed', message: e.message });
  }
});

export default router;
