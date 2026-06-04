import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { config } from '../../config';
import { authService, JwtPayload } from '../../services/auth.service';

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
    isServiceToken?: boolean;
  }
}

/**
 * Middleware: requiere auth (JWT humano O API key de servicio).
 *
 * Tres modos de auth aceptados:
 *  1. Authorization: Bearer <jwt>  -> usuario humano (req.user populado)
 *  2. Authorization: Bearer <API_KEY_DASHBOARD>  -> token de servicio (req.isServiceToken=true)
 *  3. x-api-key: <API_KEY_DASHBOARD>  -> token de servicio (idem)
 *
 * El token de servicio se mantiene para integraciones backend a backend
 * (curl, scripts, otros sistemas) sin necesidad de loguear un usuario.
 */
export async function authRequired(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.header('authorization') ?? '';
  const apiKey = req.header('x-api-key') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  // Aceptar token via query string SOLO para endpoints de navegacion (no API) que requieren
  // abrirse en nueva pestaña del browser (ej. Bull Board en /admin/queues).
  const isAdminPath = req.originalUrl.startsWith('/admin/');
  const queryToken = typeof req.query?.token === 'string' && isAdminPath
    ? String(req.query.token)
    : '';
  // Cookie para que assets estaticos (CSS/JS/imgs) de Bull Board no requieran ?token= en cada request.
  // La cookie se setea cuando vino ?token= valido. HttpOnly + Secure + SameSite=Strict.
  const cookieRaw = req.header('cookie') ?? '';
  const cookieMatch = isAdminPath ? cookieRaw.match(/(?:^|;\s*)ajm_admin_token=([^;]+)/) : null;
  const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  const candidate = bearer || apiKey || queryToken || cookieToken;

  if (!candidate) {
    res.status(401).json({ error: 'unauthorized', reason: 'missing_token' });
    return;
  }

  // Service token (legacy / integraciones)
  if (candidate === config.API_KEY_DASHBOARD) {
    req.isServiceToken = true;
    next();
    return;
  }

  // JWT de usuario
  try {
    const payload = await authService.verifyToken(candidate);
    req.user = payload;
    // Si vino por query token a /admin/* y no había cookie aún, setear cookie para próximos assets.
    if (queryToken && isAdminPath && !cookieToken) {
      // Cookie de corta duración (1h), restringida al path /admin
      res.setHeader('Set-Cookie', `ajm_admin_token=${encodeURIComponent(queryToken)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600`);
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'unauthorized', reason: (err as Error).message });
  }
}

/**
 * Requiere rol especifico. Si el caller usa service token, se acepta como ADMIN.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.isServiceToken) { next(); return; }
    if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'forbidden', need: roles, has: req.user.role });
      return;
    }
    next();
  };
}

/** Atajos comunes */
export const requireAdmin = requireRole('ADMIN');
export const requireOperator = requireRole('ADMIN', 'OPERATOR');
