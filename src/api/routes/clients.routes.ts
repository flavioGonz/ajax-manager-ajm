import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';

type AuthReq = Request & { user?: { sub: string; email?: string; role?: string } };

const router: Router = Router();

const clientSchema = z.object({
  name: z.string().min(1).max(200),
  registrationNumber: z.string().max(50).optional().nullable(),
  monitored: z.boolean().default(false),
  responseCompany: z.string().max(100).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().max(50).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

function isAdmin(req: AuthReq): boolean {
  return (req.user?.role || '').toUpperCase() === 'ADMIN';
}

// GET /api/clients - listar clientes (admin ve todo, otros solo los que tienen acceso)
router.get('/', async (req: AuthReq, res: Response) => {
  const userId = req.user?.sub;
  const where = isAdmin(req)
    ? {}
    : { userAccess: { some: { userId } } };
  const clients = await prisma.managedClient.findMany({
    where,
    include: {
      hubLinks: { select: { hubId: true } },
      _count: { select: { userAccess: true } },
    },
    orderBy: { name: 'asc' },
  });
  res.json({ data: clients });
});

// POST /api/clients - crear cliente (admin)
router.post('/', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid', issues: parsed.error.issues }); return; }
  const data = parsed.data;
  const c = await prisma.managedClient.create({
    data: { ...data, email: data.email || null },
  });
  logger.info({ id: c.id, name: c.name, userId: req.user?.sub }, 'managed client creado');
  res.json(c);
});

// PUT /api/clients/:id
router.put('/:id', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const id = String(req.params.id || '');
  const parsed = clientSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid', issues: parsed.error.issues }); return; }
  const data = parsed.data as Record<string, unknown>;
  if (data.email === '') data.email = null;
  try {
    const c = await prisma.managedClient.update({ where: { id }, data });
    res.json(c);
  } catch (err) {
    res.status(404).json({ error: 'not_found', message: (err as Error).message });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const id = String(req.params.id || '');
  try {
    await prisma.managedClient.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: 'not_found' });
  }
});

// GET /api/clients/:id - detalle
router.get('/:id', async (req: AuthReq, res: Response) => {
  const id = String(req.params.id || '');
  const c = await prisma.managedClient.findUnique({
    where: { id },
    include: { hubLinks: true, userAccess: { include: { user: { select: { id: true, email: true, fullName: true, role: true } } } } },
  });
  if (!c) { res.status(404).json({ error: 'not_found' }); return; }
  if (!isAdmin(req)) {
    const userId = req.user?.sub;
    if (!c.userAccess.some((a) => a.userId === userId)) {
      res.status(403).json({ error: 'no_access' }); return;
    }
  }
  res.json(c);
});

// POST /api/clients/:id/hubs - vincular hub
router.post('/:id/hubs', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const id = String(req.params.id || '');
  const hubId = String((req.body && req.body.hubId) || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(hubId)) { res.status(400).json({ error: 'invalid_hubId' }); return; }
  try {
    const link = await prisma.hubClientLink.upsert({
      where: { hubId },
      create: { hubId, clientId: id },
      update: { clientId: id },
    });
    res.json(link);
  } catch (err) {
    res.status(500).json({ error: 'link_failed', message: (err as Error).message });
  }
});

// DELETE /api/clients/:id/hubs/:hubId
router.delete('/:id/hubs/:hubId', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const hubId = String(req.params.hubId || '');
  await prisma.hubClientLink.deleteMany({ where: { hubId, clientId: String(req.params.id) } });
  res.json({ ok: true });
});

// GET /api/clients/:id/access - lista usuarios con acceso
router.get('/:id/access', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const id = String(req.params.id || '');
  const access = await prisma.userClientAccess.findMany({
    where: { clientId: id },
    include: { user: { select: { id: true, email: true, fullName: true, role: true } } },
  });
  res.json({ data: access });
});

// POST /api/clients/:id/access - asignar usuario
router.post('/:id/access', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  const id = String(req.params.id || '');
  const userId = String((req.body && req.body.userId) || '');
  if (!/^[0-9a-f-]{8,}$/i.test(userId)) { res.status(400).json({ error: 'invalid_userId' }); return; }
  try {
    const a = await prisma.userClientAccess.upsert({
      where: { userId_clientId: { userId, clientId: id } },
      create: { userId, clientId: id },
      update: {},
    });
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: 'assign_failed', message: (err as Error).message });
  }
});

// DELETE /api/clients/:id/access/:userId
router.delete('/:id/access/:userId', async (req: AuthReq, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_required' }); return; }
  await prisma.userClientAccess.deleteMany({
    where: { clientId: String(req.params.id), userId: String(req.params.userId) },
  });
  res.json({ ok: true });
});

// GET /api/clients/me/hubs - hubIds permitidos al usuario logueado
router.get('/me/hubs', async (req: AuthReq, res: Response) => {
  const userId = req.user?.sub || '';
  const role = (req.user?.role || '').toUpperCase();
  if (role === 'ADMIN') {
    res.json({ allHubs: true, hubIds: null });
    return;
  }
  const access = await prisma.userClientAccess.findMany({
    where: { userId },
    select: { client: { select: { id: true, name: true, hubLinks: { select: { hubId: true } } } } },
  });
  const hubIds = new Set<string>();
  const clients: Array<{ id: string; name: string; hubIds: string[] }> = [];
  for (const a of access) {
    const cl = a.client;
    if (!cl) continue;
    const ids = cl.hubLinks.map((h) => h.hubId);
    ids.forEach((id) => hubIds.add(id));
    clients.push({ id: cl.id, name: cl.name, hubIds: ids });
  }
  res.json({ allHubs: false, hubIds: Array.from(hubIds), clients });
});


// GET /api/clients/by-hub/:hubId - cliente vinculado a un hub (si existe)
router.get('/by-hub/:hubId', async (req: AuthReq, res: Response) => {
  const hubId = String(req.params.hubId || '');
  const link = await prisma.hubClientLink.findUnique({
    where: { hubId },
    include: { client: { include: { _count: { select: { hubLinks: true, userAccess: true } } } } },
  });
  if (!link) { res.json({ client: null }); return; }
  // Si no es admin, verificar acceso
  if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
    const has = await prisma.userClientAccess.findFirst({
      where: { userId: req.user?.sub || '', clientId: link.clientId },
    });
    if (!has) { res.status(403).json({ error: 'no_access' }); return; }
  }
  res.json({ client: link.client });
});


// GET /api/clients/distinct - valores existentes para autocomplete
router.get('/distinct/values', async (_req: AuthReq, res: Response) => {
  const [regs, companies] = await Promise.all([
    prisma.managedClient.findMany({
      where: { registrationNumber: { not: null } },
      select: { registrationNumber: true, name: true },
      distinct: ['registrationNumber'],
      orderBy: { registrationNumber: 'asc' },
    }),
    prisma.managedClient.findMany({
      where: { responseCompany: { not: null } },
      select: { responseCompany: true },
      distinct: ['responseCompany'],
      orderBy: { responseCompany: 'asc' },
    }),
  ]);
  res.json({
    registrationNumbers: regs.map((r) => ({ value: r.registrationNumber, client: r.name })),
    responseCompanies: companies.map((c) => c.responseCompany).filter(Boolean),
  });
});

export default router;
