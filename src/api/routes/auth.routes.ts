import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { authService, toSafeUser } from '../../services/auth.service';
import { audit } from '../../services/audit.service';
import { authRequired } from '../middlewares/auth.middleware';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';

const router: Router = Router();

// Rate limit estricto en login para evitar fuerza bruta: 5 intentos / minuto / IP
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', retryAfter: 60 },
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { email, password } = parsed.data;

  const result = await authService.login(email, password);
  if (!result) {
    await audit(req, 'auth.login.failed', { metadata: { email } });
    logger.warn({ email }, 'login fallido');
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  await audit(req, 'auth.login.ok', { userId: result.user.id });
  return res.json({ token: result.token, user: result.user });
});

router.post('/logout', authRequired, async (req, res) => {
  // Service token no tiene logout
  if (req.isServiceToken) return res.status(400).json({ error: 'service_token_no_logout' });
  if (!req.user) return res.status(401).json({ error: 'no_user_context' });
  const auth = req.header('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!bearer) return res.status(400).json({ error: 'no_bearer' });
  // revokeToken hace verify + check jti === req.user.jti antes de revocar
  const ok = await authService.revokeToken(bearer, req.user.jti);
  if (!ok) return res.status(401).json({ error: 'token_mismatch' });
  await audit(req, 'auth.logout', { userId: req.user.sub });
  return res.json({ ok: true });
});

router.get('/me', authRequired, async (req, res) => {
  if (req.isServiceToken) {
    return res.json({ user: null, serviceToken: true });
  }
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  const u = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ user: toSafeUser(u), serviceToken: false });
});

const changePassSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8, 'minimo 8 chars'),
});
router.post('/change-password', authRequired, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  const parsed = changePassSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const ok = await authService.changePassword(req.user.sub, parsed.data.oldPassword, parsed.data.newPassword);
  if (!ok) return res.status(403).json({ error: 'wrong_old_password' });
  await audit(req, 'auth.password.changed', { userId: req.user.sub });
  return res.json({ ok: true });
});

export default router;
