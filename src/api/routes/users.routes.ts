import { Router } from 'express';
import { z } from 'zod';
import { authRequired, requireAdmin } from '../middlewares/auth.middleware';
import { prisma } from '../../utils/prisma';
import { authService, toSafeUser } from '../../services/auth.service';
import { audit } from '../../services/audit.service';

const router: Router = Router();

const createSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  fullName: z.string().min(1).max(120).optional(),
  role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']).default('VIEWER'),
  active: z.boolean().default(true),
});

const updateSchema = createSchema.partial().omit({ password: true }).extend({
  password: z.string().min(8).optional(),
});

router.use(authRequired, requireAdmin);

router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ data: users.map(toSafeUser) });
});

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        fullName: parsed.data.fullName,
        role: parsed.data.role,
        active: parsed.data.active,
        passwordHash: await authService.hashPassword(parsed.data.password),
      },
    });
    await audit(req, 'user.create', { resource: user.id, metadata: { role: user.role } });
    return res.status(201).json(toSafeUser(user));
  } catch (e) {
    return res.status(409).json({ error: 'email_taken_or_invalid' });
  }
});

router.patch('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.password) {
    data.passwordHash = await authService.hashPassword(parsed.data.password);
    delete data.password;
  }
  try {
    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    await audit(req, 'user.update', { resource: user.id });
    return res.json(toSafeUser(user));
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }
});

router.delete('/:id', async (req, res) => {
  // Soft delete: marcamos active=false en vez de borrar para preservar audit trail.
  if (req.user?.sub === req.params.id) {
    return res.status(400).json({ error: 'cannot_delete_self' });
  }
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { active: false } });
    await audit(req, 'user.deactivate', { resource: req.params.id });
    return res.status(204).end();
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }
});

export default router;
