import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../utils/prisma';
import { getVapidPublicKey, sendPushForEvent } from '../../services/push.service';
import { hasPush } from '../../config';
import { logger } from '../../utils/logger';

type AuthReq = Request & { user?: { sub: string; email?: string; role?: string } };

const router: Router = Router();

// GET /api/push/vapid-key - clave publica para que el frontend se suscriba
router.get('/vapid-key', (_req, res) => {
  if (!hasPush()) {
    res.status(503).json({ error: 'push_not_configured' });
    return;
  }
  res.json({ publicKey: getVapidPublicKey() });
});

// POST /api/push/subscribe - registra la subscription del navegador
router.post('/subscribe', async (req: AuthReq, res: Response) => {
  if (!hasPush()) {
    res.status(503).json({ error: 'push_not_configured' });
    return;
  }
  const body = req.body || {};
  const sub = body.subscription || body;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    res.status(400).json({ error: 'invalid_subscription' });
    return;
  }
  const userId = req.user?.sub || null;
  const userAgent = req.headers['user-agent'] || null;
  const severities = Array.isArray(body.severities) ? body.severities.filter((s: unknown) => typeof s === 'string') as string[] : [];

  try {
    // Upsert por endpoint
    const saved = await prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userId,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
        severities,
        active: true,
        failures: 0,
      },
      update: {
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userId,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
        severities,
        active: true,
        failures: 0,
        lastFailure: null,
      },
    });
    logger.info({ id: saved.id, userId }, 'push subscription registrada');
    res.json({ ok: true, id: saved.id });
  } catch (err) {
    res.status(500).json({ error: 'subscribe_failed', message: (err as Error).message });
  }
});

// POST /api/push/unsubscribe - elimina por endpoint
router.post('/unsubscribe', async (req: AuthReq, res: Response) => {
  const endpoint = (req.body && req.body.endpoint) || '';
  if (!endpoint || typeof endpoint !== 'string') {
    res.status(400).json({ error: 'missing_endpoint' });
    return;
  }
  try {
    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'unsubscribe_failed', message: (err as Error).message });
  }
});

// GET /api/push/status - mis subscripciones
router.get('/status', async (req: AuthReq, res: Response) => {
  if (!hasPush()) {
    res.json({ configured: false });
    return;
  }
  const userId = req.user?.sub;
  if (!userId) { res.json({ configured: true, subscriptions: [] }); return; }
  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, active: true, userAgent: true, severities: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ configured: true, subscriptions: subs });
});

// POST /api/push/test - envia una notif de prueba a mis subs
router.post('/test', async (_req: AuthReq, res: Response) => {
  if (!hasPush()) {
    res.status(503).json({ error: 'push_not_configured' });
    return;
  }
  // Buscamos el ultimo evento ALARM para usar de prueba
  const lastAlarm = await prisma.ajaxEvent.findFirst({
    where: { severity: 'ALARM' },
    orderBy: { receivedAt: 'desc' },
  });
  if (!lastAlarm) {
    res.status(400).json({ error: 'no_test_event', message: 'No hay ningun evento ALARM para usar de prueba' });
    return;
  }
  const result = await sendPushForEvent(lastAlarm);
  res.json({ ok: true, ...result });
});

export default router;
