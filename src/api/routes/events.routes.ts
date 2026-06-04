import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { getAllowedHubIds } from '../../services/tenant-scope.service';

const ACK_KEY = (id: string) => `ack:evt:${id}`;
const ACK_TTL_SEC = 30 * 24 * 60 * 60;

type AuthReq = Request & { user?: { sub: string; email?: string; role?: string } };

const router: Router = Router();

const listQuerySchema = z.object({
  hubId: z.string().optional(),
  severity: z.enum(['ALARM', 'WARNING', 'INFO', 'MAINTENANCE', 'UNKNOWN']).optional(),
  status: z.enum(['RECEIVED', 'PROCESSED', 'DISPATCHED', 'FAILED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(150),
  cursor: z.string().uuid().optional(),
  // Busqueda full-text en description / eventCode / hubId / rawPayload (server-side)
  q: z.string().trim().max(200).optional(),
  // Filtros booleanos
  hasPhoto: z.coerce.boolean().optional(),    // true = solo eventos con __localPhotos
  isAlarm: z.coerce.boolean().optional(),      // alias de severity=ALARM
});

router.get('/', async (req: AuthReq, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
  }
  const q = parsed.data;

  // Build WHERE clause
  type WhereClause = Record<string, unknown>;
  const where: WhereClause = {};
  if (q.hubId) where.hubId = q.hubId;
  if (q.isAlarm) where.severity = 'ALARM';
  else if (q.severity) where.severity = q.severity;
  if (q.status) where.status = q.status;
  if (q.from || q.to) {
    where.receivedAt = {
      ...(q.from ? { gte: q.from } : {}),
      ...(q.to ? { lte: q.to } : {}),
    };
  }
  // Full-text search across description, eventCode, hubId, ajaxEventId
  if (q.q && q.q.length >= 2) {
    const term = q.q.trim();
    const orClauses: WhereClause[] = [
      { description: { contains: term, mode: 'insensitive' } },
      { eventCode:   { contains: term, mode: 'insensitive' } },
      { hubId:       { contains: term, mode: 'insensitive' } },
      { ajaxEventId: { contains: term, mode: 'insensitive' } },
    ];
    // Si el termino parece eventTag PascalCase / sensor name, tambien buscar en rawPayload via raw SQL
    // (Prisma JSON query no es directo; aceptamos el OR sobre campos texto)
    where.OR = orClauses;
  }
  // Tenant scope: si el usuario no es ADMIN, solo ve eventos de hubs de sus clientes asignados
  const allowedHubIds = await getAllowedHubIds(req.user?.sub || '', (req.user?.role || '').toUpperCase());
  if (allowedHubIds !== null) {
    // Empty array -> no events (intencional)
    if (allowedHubIds.length === 0) {
      // Return empty quickly
      res.json({ data: [], nextCursor: null });
      return;
    }
    // Si ya hay un hubId en el WHERE, debe estar en la lista permitida
    if (where.hubId && typeof where.hubId === 'string') {
      if (!allowedHubIds.includes(where.hubId)) {
        res.json({ data: [], nextCursor: null });
        return;
      }
    } else {
      // Aplicar IN ()
      where.hubId = { in: allowedHubIds };
    }
  }
  // Filtro hasPhoto: usa raw SQL via $queryRaw seria mas eficiente,
  // pero con Prisma JSON path filter funciona: rawPayload contains key '__localPhotos'
  if (q.hasPhoto === true) {
    // Filtro nativo Postgres: rawPayload ? '__localPhotos'
    where.rawPayload = { path: ['__localPhotos'], not: null as never };
  }

  const events = await prisma.ajaxEvent.findMany({
    where,
    orderBy: { receivedAt: 'desc' },
    take: q.limit,
    ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    select: {
      id: true, hubId: true, eventCode: true, protocol: true,
      description: true, severity: true,
      occurredAt: true, receivedAt: true, status: true,
      rawPayload: true,
      // Deliveries (solo lo necesario para mostrar iconos/hora en la columna Estado)
      deliveries: {
        select: {
          id: true, status: true, completedAt: true, startedAt: true, attempt: true,
          subscription: { select: { id: true, name: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      },
    },
  });

  let ackStates: (string | null)[] = [];
  if (events.length > 0) {
    try { ackStates = await redis.mget(...events.map((e) => ACK_KEY(e.id))); }
    catch { ackStates = events.map(() => null); }
  }
  const enriched = events.map((e, i) => {
    const raw = ackStates[i];
    let acknowledged: { at: string; by: string } | null = null;
    if (raw) { try { acknowledged = JSON.parse(raw); } catch { /* ignore */ } }
    return { ...e, acknowledged };
  });

  return res.json({
    data: enriched,
    nextCursor: events.length === q.limit ? events[events.length - 1].id : null,
  });
});

router.get('/:id', async (req, res) => {
  const event = await prisma.ajaxEvent.findUnique({
    where: { id: req.params.id },
    include: {
      deliveries: {
        select: {
          id: true, subscriptionId: true, attempt: true, status: true,
          httpStatus: true, startedAt: true, completedAt: true, errorMessage: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!event) return res.status(404).json({ error: 'not_found' });
  return res.json(event);
});

router.get('/stats/summary', async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [grouped, byProtocol] = await Promise.all([
    prisma.ajaxEvent.groupBy({ by: ['severity'], _count: { _all: true }, where: { receivedAt: { gte: since } } }),
    prisma.ajaxEvent.groupBy({ by: ['protocol'], _count: { _all: true }, where: { receivedAt: { gte: since } } }),
  ]);
  return res.json({
    since,
    counts: grouped.map((g) => ({ severity: g.severity, count: g._count._all })),
    byProtocol: byProtocol.map((g) => ({ protocol: g.protocol, count: g._count._all })),
  });
});

router.post('/:id/acknowledge', async (req: AuthReq, res) => {
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'missing_id' });
  const ev = await prisma.ajaxEvent.findUnique({ where: { id }, select: { id: true } });
  if (!ev) return res.status(404).json({ error: 'event_not_found' });
  const ack = {
    at: new Date().toISOString(),
    by: req.user?.email || req.user?.sub || 'unknown',
  };
  try {
    await redis.set(ACK_KEY(id), JSON.stringify(ack), 'EX', ACK_TTL_SEC);
  } catch (err) {
    return res.status(500).json({ error: 'redis_failed', message: (err as Error).message });
  }
  return res.json({ ok: true, acknowledged: ack });
});

router.delete('/:id/acknowledge', async (req, res) => {
  try { await redis.del(ACK_KEY(String(req.params.id))); } catch { /* ignore */ }
  return res.json({ ok: true });
});

router.get('/alarms/open', async (_req, res) => {
  const alarms = await prisma.ajaxEvent.findMany({
    where: { severity: 'ALARM' },
    orderBy: { receivedAt: 'desc' },
    take: 200,
    select: { id: true, hubId: true, eventCode: true, description: true, occurredAt: true, receivedAt: true },
  });
  if (alarms.length === 0) return res.json({ count: 0, data: [] });
  let ackStates: (string | null)[] = [];
  try { ackStates = await redis.mget(...alarms.map((a) => ACK_KEY(a.id))); }
  catch { ackStates = alarms.map(() => null); }
  const open = alarms.filter((_a, i) => !ackStates[i]);
  return res.json({ count: open.length, data: open.slice(0, 50) });
});

export default router;
