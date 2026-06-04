import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireOperator } from '../middlewares/auth.middleware';
import { dispatchByChannel } from '../../services/channels';
import { logger } from '../../utils/logger';

const router: Router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['HTTP', 'EMAIL', 'SLACK', 'TELEGRAM', 'SCADA_OPC']).default('HTTP'),
  url: z.string().url().optional().nullable(),
  secret: z.string().min(8).optional().nullable(),
  filters: z
    .object({
      hubIds: z.array(z.string()).optional(),
      severities: z.array(z.enum(['ALARM', 'WARNING', 'INFO', 'MAINTENANCE', 'UNKNOWN'])).optional(),
      eventCodes: z.array(z.string()).optional(),
    })
    .optional(),
  active: z.boolean().default(true),
  extraHeaders: z.record(z.string()).optional(),
  config: z.record(z.unknown()).optional(), // configuracion especifica por tipo
});

router.get('/', async (_req, res) => {
  const subs = await prisma.webhookSubscription.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ data: subs });
});

router.post('/', requireOperator, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  // Validacion adicional segun type
  const v = validateChannelData(parsed.data);
  if (v) return res.status(400).json({ error: v });
  try {
    const sub = await prisma.webhookSubscription.create({
      data: {
        name: parsed.data.name,
        type: parsed.data.type,
        url: parsed.data.url ?? null,
        secret: parsed.data.secret ?? null,
        active: parsed.data.active,
        filters: (parsed.data.filters ?? null) as never,
        extraHeaders: (parsed.data.extraHeaders ?? null) as never,
        config: (parsed.data.config ?? null) as never,
      },
    });
    return res.status(201).json(sub);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/:id', requireOperator, async (req, res) => {
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  try {
    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.type !== undefined) data.type = parsed.data.type;
    if (parsed.data.url !== undefined) data.url = parsed.data.url;
    if (parsed.data.secret !== undefined) data.secret = parsed.data.secret;
    if (parsed.data.active !== undefined) data.active = parsed.data.active;
    if (parsed.data.filters !== undefined) data.filters = parsed.data.filters;
    if (parsed.data.extraHeaders !== undefined) data.extraHeaders = parsed.data.extraHeaders;
    if (parsed.data.config !== undefined) data.config = parsed.data.config;
    const sub = await prisma.webhookSubscription.update({
      where: { id: String(req.params.id) },
      data: data as never,
    });
    return res.json(sub);
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }
});

router.delete('/:id', requireOperator, async (req, res) => {
  try {
    await prisma.webhookSubscription.delete({ where: { id: String(req.params.id) } });
    return res.status(204).end();
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }
});

function validateChannelData(d: { type?: string; url?: string | null; config?: Record<string, unknown> }): string | null {
  const cfg = d.config || {};
  switch (d.type) {
    case 'HTTP':
      if (!d.url) return 'http_url_required';
      return null;
    case 'SLACK':
      if (!d.url && !cfg.webhookUrl) return 'slack_webhook_url_required';
      return null;
    case 'EMAIL':
      if (!cfg.to) return 'email_to_required';
      if (!cfg.smtpHost) return 'smtp_host_required';
      if (!cfg.smtpUser || !cfg.smtpPass) return 'smtp_auth_required';
      return null;
    case 'TELEGRAM':
      if (!cfg.botToken) return 'telegram_bot_token_required';
      if (!cfg.chatId) return 'telegram_chat_id_required';
      return null;
    case 'SCADA_OPC':
      if (!cfg.endpointUrl) return 'opc_endpoint_url_required';
      return null;
    default:
      return null;
  }
}

/**
 * POST /api/subscriptions/:id/test - Envía un evento sintético al canal para probar la configuración.
 * Útil para validar que el webhook URL, las credenciales SMTP, el token Telegram, etc. funcionen.
 */
router.post('/:id/test', requireOperator, async (req, res) => {
  try {
    const sub = await prisma.webhookSubscription.findUnique({ where: { id: String(req.params.id) } });
    if (!sub) return res.status(404).json({ error: 'subscription_not_found' });
    if (!sub.active) return res.status(400).json({ error: 'subscription_inactive', hint: 'Activá el canal antes de probarlo' });

    // Evento sintético (NO se guarda en BD)
    const now = new Date();
    const fakeEvent = {
      id: 'test-' + Date.now().toString(36),
      sqsMessageId: 'test-' + Date.now().toString(36),
      messageGroupId: null,
      ajaxEventId: null,
      hubId: 'TEST-HUB',
      eventCode: 'TEST',
      protocol: 'TEST',
      description: `Test de canal ${sub.type} · ${sub.name}. Si recibís este mensaje, la integración funciona.`,
      severity: 'INFO' as const,
      occurredAt: now,
      receivedAt: now,
      processedAt: now,
      status: 'PROCESSED',
      errorMessage: null,
      rawPayload: { test: true, subscriptionId: sub.id, subscriptionName: sub.name, sentAt: now.toISOString() } as object,
    };
    const result = await dispatchByChannel(fakeEvent as never, sub);
    logger.info({ subId: sub.id, type: sub.type, ok: result.ok, by: req.user?.sub }, 'subscription test fired');
    if (result.ok) {
      return res.json({ ok: true, channel: sub.type, message: `Test enviado a ${sub.type}`, result });
    } else {
      return res.status(502).json({ ok: false, channel: sub.type, error: result.errorMessage || 'test_failed', httpStatus: result.httpStatus, responseBody: result.responseBody });
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'subscription test error');
    return res.status(500).json({ error: 'test_failed', message: (err as Error).message });
  }
});

export default router;
