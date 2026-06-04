import { Router, Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { dispatcherService } from '../../services/dispatcher.service';
import { config, hasCompanyAuth, hasUserAuth } from '../../config';
import { requireOperator, requireAdmin } from '../middlewares/auth.middleware';
import { logger } from '../../utils/logger';
import { getAjaxClientStats } from '../../services/ajax-api.client';
import { getDebugEntries, clearDebugLog } from '../../utils/debug-log';
import { opcServerService } from '../../services/opc-server.service';
import { getScadaOpcStatus } from '../../services/channels/scada-opc.channel';
import { backfillRecentMotionCamPhotos } from '../../services/photo-cache.service';

const router: Router = Router();
const PAUSE_FLAG_KEY = 'ajm:webhooks:paused';
const startedAt = Date.now();
const ENV_PATH = process.env.ENV_FILE_PATH || path.resolve(process.cwd(), '.env');
const EDITABLE_KEYS = [
  'AJAX_COMPANY_TOKEN','AJAX_COMPANY_ID',
  'X_API_KEY','AJAX_API_BASE_URL',
  'WEBHOOK_RETRY_ATTEMPTS','WEBHOOK_RETRY_BACKOFF_MS','WEBHOOK_TIMEOUT_MS',
  'DEMO_MODE',
  'OPC_ENABLED','OPC_PORT','OPC_RESOURCE_PATH','OPC_USERNAME','OPC_PASSWORD',
];
const SECRET_KEYS = ['AJAX_COMPANY_TOKEN','X_API_KEY','OPC_PASSWORD'];

function maskSecret(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '***';
  return v.slice(0, 3) + '***' + v.slice(-3);
}

router.get('/info', async (_req, res) => {
  try {
    const [postgresOk, redisOk, queueCounts, totalEvents, totalSubs] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis.ping().then((r) => r === 'PONG').catch(() => false),
      dispatcherService.queue.getJobCounts('waiting','active','delayed','completed','failed'),
      prisma.ajaxEvent.count(),
      prisma.webhookSubscription.count(),
    ]);
    const webhooksPaused = (await redis.get(PAUSE_FLAG_KEY)) === '1';
    return res.json({
      service: 'ajax-manager-ajm', version: '0.7.0', env: config.NODE_ENV,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      processStartedAt: new Date(startedAt).toISOString(),
      checks: { postgres: postgresOk, redis: redisOk },
      queue: queueCounts, counts: { events: totalEvents, subscriptions: totalSubs },
      ajax: { intId: config.AJAX_INT_ID, baseUrl: config.AJAX_API_BASE_URL, hasCompanyAuth, hasUserAuth, companyId: config.AJAX_COMPANY_ID || null, rateLimit: getAjaxClientStats() },
      sqs: { region: config.AWS_REGION, queue: config.SQS_URL.replace(/\/\d{12}\//, '/***/') },
      webhooksPaused,
    });
  } catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});

router.get('/timeseries', async (req, res) => {
  const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; severity: string | null; n: bigint }>>`
    SELECT date_trunc('hour', received_at) AS bucket, severity, COUNT(*)::bigint AS n
    FROM ajax_events WHERE received_at >= ${since}
    GROUP BY 1, 2 ORDER BY 1`;
  return res.json({ since, hours, points: rows.map((r) => ({ bucket: r.bucket, severity: r.severity ?? 'UNKNOWN', count: Number(r.n) })) });
});

router.get('/deliveries', async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const deliveries = await prisma.webhookDelivery.findMany({
    where: status ? { status: status as never } : undefined,
    take: limit, orderBy: { createdAt: 'desc' },
    include: { subscription: { select: { id: true, name: true, url: true } }, event: { select: { id: true, eventCode: true, severity: true, hubId: true } } },
  });
  return res.json({ data: deliveries });
});

router.post('/deliveries/:id/retry', requireOperator, async (req: Request, res) => {
  const id = String(req.params.id);
  try {
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id }, include: { subscription: true, event: true } });
    if (!delivery) return res.status(404).json({ error: 'delivery_not_found' });
    if (!delivery.subscription || !delivery.subscription.active) return res.status(400).json({ error: 'subscription_inactive_or_missing' });
    if (delivery.status === 'SUCCEEDED') return res.status(400).json({ error: 'already_delivered' });
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: 'PENDING', errorMessage: null, attempt: (delivery.attempt ?? 0) + 1, completedAt: null, startedAt: null },
    });
    await dispatcherService.queue.add('webhook-deliver',
      { eventId: delivery.eventId, subscriptionId: delivery.subscriptionId },
      { jobId: `delivery_${id}_retry_${Date.now()}`, attempts: config.WEBHOOK_RETRY_ATTEMPTS, backoff: { type: 'exponential', delay: config.WEBHOOK_RETRY_BACKOFF_MS } },
    );
    return res.json({ ok: true, id });
  } catch (err) { return res.status(500).json({ error: 'retry_failed' }); }
});

router.post('/deliveries/:id/cancel', requireOperator, async (req: Request, res) => {
  const id = String(req.params.id);
  try {
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id } });
    if (!delivery) return res.status(404).json({ error: 'delivery_not_found' });
    if (delivery.status === 'SUCCEEDED') return res.status(400).json({ error: 'already_delivered' });
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: 'DEAD_LETTER', errorMessage: `Cancelado por user ${req.user?.sub ?? '?'}`, completedAt: new Date() },
    });
    return res.json({ ok: true, id });
  } catch (err) { return res.status(500).json({ error: 'cancel_failed' }); }
});

router.post('/webhooks/pause', requireOperator, async (_req: Request, res) => {
  try { await dispatcherService.queue.pause(); await redis.set(PAUSE_FLAG_KEY, '1'); return res.json({ ok: true, paused: true }); }
  catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});
router.post('/webhooks/resume', requireOperator, async (_req: Request, res) => {
  try { await dispatcherService.queue.resume(); await redis.del(PAUSE_FLAG_KEY); return res.json({ ok: true, paused: false }); }
  catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});
router.post('/webhooks/retry-failed', requireAdmin, async (_req: Request, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const failed = await prisma.webhookDelivery.findMany({
      where: { status: { in: ['FAILED','DEAD_LETTER'] }, createdAt: { gte: since }, subscription: { active: true } },
      select: { id: true, eventId: true, subscriptionId: true }, take: 500,
    });
    for (const d of failed) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', errorMessage: null, completedAt: null, startedAt: null } });
      await dispatcherService.queue.add('webhook-deliver',
        { eventId: d.eventId, subscriptionId: d.subscriptionId },
        { jobId: `delivery_${d.id}_retry_${Date.now()}`, attempts: config.WEBHOOK_RETRY_ATTEMPTS, backoff: { type: 'exponential', delay: config.WEBHOOK_RETRY_BACKOFF_MS } },
      );
    }
    return res.json({ ok: true, requeued: failed.length });
  } catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});

router.get('/debug/log', requireOperator, async (req: Request, res) => {
  const since = req.query.since ? Number(req.query.since) : undefined;
  const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 200;
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  const level = typeof req.query.level === 'string' ? req.query.level : undefined;
  res.json({ data: getDebugEntries({ since, limit, source, level }) });
});
router.post('/debug/clear', requireOperator, async (_req: Request, res) => { clearDebugLog(); res.json({ ok: true }); });

router.get('/opc/status', async (_req: Request, res) => { res.json(opcServerService.getStatus()); });
router.get('/opc/client/status', async (_req: Request, res) => { res.json(getScadaOpcStatus()); });

// === Diagnostico MotionCam / Photo Cache ===
router.get('/photo-cache/stats', requireOperator, async (_req: Request, res) => {
  try {
    const DEVICE_IMAGES_DIR = process.env.DEVICE_IMAGES_DIR || '/app/data/device-images';
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 1. Contar archivos en el disco
    let diskFiles = 0;
    let diskBytes = 0;
    let oldestFile: Date | null = null;
    let newestFile: Date | null = null;
    try {
      const entries = fs.readdirSync(DEVICE_IMAGES_DIR);
      diskFiles = entries.length;
      for (const e of entries.slice(0, 1000)) {
        try {
          const st = fs.statSync(path.join(DEVICE_IMAGES_DIR, e));
          diskBytes += st.size;
          if (!oldestFile || st.mtime < oldestFile) oldestFile = st.mtime;
          if (!newestFile || st.mtime > newestFile) newestFile = st.mtime;
        } catch { /* ignore */ }
      }
    } catch { /* dir no existe */ }

    // 2. Eventos con __localPhotos (descargados OK)
    const cachedLast24h = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM ajax_events
      WHERE received_at >= ${since24h}
        AND raw_payload::text LIKE '%__localPhotos%'
    `;
    const cachedLast7d = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM ajax_events
      WHERE received_at >= ${since7d}
        AND raw_payload::text LIKE '%__localPhotos%'
    `;
    // 3. Eventos con orderedResourceLinks (candidatos a MotionCam) pero sin __localPhotos
    const candidatesNoCache = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM ajax_events
      WHERE received_at >= ${since7d}
        AND raw_payload::text LIKE '%orderedResourceLinks%'
        AND raw_payload::text NOT LIKE '%__localPhotos%'
    `;
    // 4. Ultimos 10 eventos MotionCam (con o sin foto cacheada)
    const recentMotionCam = await prisma.$queryRaw<Array<{
      id: string; event_code: string | null; description: string | null;
      hub_id: string | null; received_at: Date;
      has_local: boolean; has_candidates: boolean;
    }>>`
      SELECT id, event_code, description, hub_id, received_at,
             (raw_payload::text LIKE '%__localPhotos%') AS has_local,
             (raw_payload::text LIKE '%orderedResourceLinks%') AS has_candidates
      FROM ajax_events
        AND (raw_payload::text LIKE '%orderedResourceLinks%' OR description ILIKE '%motioncam%' OR description ILIKE '%foto%')
      ORDER BY received_at DESC
      LIMIT 10
    `;
    return res.json({
      dir: DEVICE_IMAGES_DIR,
      disk: { files: diskFiles, bytes: diskBytes, mb: Math.round(diskBytes / 1024 / 1024 * 10) / 10, oldestFile, newestFile },
      cached: { last24h: Number(cachedLast24h[0]?.n || 0), last7d: Number(cachedLast7d[0]?.n || 0) },
      candidatesWithoutCache: Number(candidatesNoCache[0]?.n || 0),
      recentMotionCam,
    });
  } catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});

router.post('/photo-cache/backfill', requireOperator, async (req: Request, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const result = await backfillRecentMotionCamPhotos(limit);
    return res.json({ ok: true, ...result });
  } catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});

router.get('/config', requireAdmin, async (_req: Request, res) => {
  try {
    const out: Record<string, { value: string; masked?: boolean }> = {};
    for (const k of EDITABLE_KEYS) {
      const raw = process.env[k] || '';
      out[k] = SECRET_KEYS.includes(k) ? { value: raw ? maskSecret(raw) : '', masked: true } : { value: raw, masked: false };
    }
    return res.json({ data: out, envPath: ENV_PATH });
  } catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});

router.post('/config', requireAdmin, async (req: Request, res) => {
  try {
    const updates = req.body as Record<string, string>;
    const allowed: Record<string, string> = {};
    for (const k of Object.keys(updates || {})) {
      if (!EDITABLE_KEYS.includes(k)) continue;
      const v = String(updates[k] ?? '');
      if (v.includes('***')) continue;
      allowed[k] = v;
    }
    if (Object.keys(allowed).length === 0) return res.status(400).json({ error: 'no_updates' });
    let envText = '';
    try { envText = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { envText = ''; }
    const lines = envText.split(/\r?\n/);
    const seen = new Set<string>();
    const newLines = lines.map((line) => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) return line;
      const key = m[1];
      if (allowed[key] !== undefined) { seen.add(key); return `${key}=${allowed[key]}`; }
      return line;
    });
    for (const k of Object.keys(allowed)) if (!seen.has(k)) newLines.push(`${k}=${allowed[k]}`);
    fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf-8');
    logger.warn({ keys: Object.keys(allowed), by: req.user?.sub }, 'Config .env actualizado');
    return res.json({ ok: true, updated: Object.keys(allowed) });
  } catch (err) { return res.status(500).json({ error: (err as Error).message }); }
});

router.post('/config/restart', requireAdmin, async (req: Request, res) => {
  logger.warn({ by: req.user?.sub }, 'Reinicio del container solicitado - process.exit en 500ms');
  res.json({ ok: true, note: 'container exiting; docker (restart: unless-stopped) lo levanta en ~3-5s' });
  setTimeout(() => {
    logger.warn('process.exit(0) - bye');
    process.exit(0);
  }, 500);
});

export default router;
