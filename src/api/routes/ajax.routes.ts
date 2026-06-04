import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ajaxCloudService } from '../../services/ajax-cloud.service';
import { ajaxAuthService } from '../../services/ajax-auth.service';
import { logger } from '../../utils/logger';
import { hasCompanyAuth, hasUserAuth } from '../../config';
import { prisma } from '../../utils/prisma';
import { getAllowedHubIds } from '../../services/tenant-scope.service';

const router: Router = Router();

/**
 * Middleware: si no hay ni Company ni User auth configurada, devolvemos 200
 * con empty-state en lugar de 502, asi el frontend muestra mensaje amigable.
 */
function requireAjaxAuth(_req: Request, res: Response, next: NextFunction) {
  if (!hasCompanyAuth && !hasUserAuth) {
    res.status(200).json({
      data: [],
      _empty: true,
      _reason: 'ajax_auth_not_configured',
      _message: 'Configura AJAX_COMPANY_TOKEN + AJAX_COMPANY_ID (recomendado) o AJAX_LOGIN + AJAX_PASSWORD en el .env para listar recursos del Ajax Cloud.',
    });
    return;
  }
  next();
}
router.use(requireAjaxAuth);

// Validador estricto para params - evita inyeccion y prototipos raros
function safeParam(name: 'hubId' | 'deviceId' | 'objectId', val: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(val)) {
    const err = new Error(`invalid_${name}`);
    (err as { status?: number }).status = 400;
    throw err;
  }
  return val;
}

// Wrapper async para que los errores de los handlers caigan en el middleware de error.
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

router.get('/login-test', wrap(async (_req, res) => {
  if (!hasUserAuth) {
    res.json({ ok: false, reason: 'no_user_auth_configured', userId: null });
    return;
  }
  const token = await ajaxAuthService.getToken();
  res.json({
    ok: true,
    userId: ajaxAuthService.getUserId(),
    sessionTokenPreview: token ? token.slice(0, 6) + '...' + token.slice(-4) : null,
  });
}));

router.get('/hubs', wrap(async (_req, res) => {
  const req = _req as import('express').Request & { user?: { sub: string; role?: string } };
  const allowedHubIds = await getAllowedHubIds(req.user?.sub || '', (req.user?.role || '').toUpperCase());
  const r = await ajaxCloudService.listHubs();
  if (allowedHubIds !== null) {
    r.data = r.data.filter((h: { hubId: string }) => allowedHubIds.includes(h.hubId));
  }
  // Enriquecer con ultima actividad + alarmas recientes desde DB
  try {
    const hubIds = r.data.map((h) => h.hubId).filter(Boolean);
    if (hubIds.length > 0) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const [lastEvents, alarmsRecent] = await Promise.all([
        prisma.ajaxEvent.groupBy({
          by: ['hubId'],
          where: { hubId: { in: hubIds } },
          _max: { receivedAt: true },
        }),
        prisma.ajaxEvent.groupBy({
          by: ['hubId'],
          where: { hubId: { in: hubIds }, severity: 'ALARM', receivedAt: { gte: fiveMinAgo } },
          _count: { id: true },
        }),
      ]);
      const lastByHub = new Map(lastEvents.map((e) => [e.hubId, e._max.receivedAt]));
      const alarmByHub = new Map(alarmsRecent.map((e) => [e.hubId, e._count.id]));
      for (const hub of r.data) {
        const ts = lastByHub.get(hub.hubId);
        const al = alarmByHub.get(hub.hubId) || 0;
        // @ts-expect-error - enriquecemos en runtime
        hub.lastActivityAt = ts ? ts.toISOString() : null;
        // @ts-expect-error
        hub.alarmsLast5min = al;
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'No se pudo enriquecer hubs con actividad reciente');
  }
  res.json(r);
}));

router.get('/clients', wrap(async (_req, res) => {
  const data = await ajaxCloudService.listAllClients();
  res.json({ data, total: data.length });
}));

router.get('/sensors', wrap(async (_req, res) => {
  const data = await ajaxCloudService.listAllSensors();
  res.json({ data, total: data.length });
}));

router.get('/hubs/:hubId/logs', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize) || 50));
  const pageIndex = Math.max(0, Number(req.query.pageIndex) || 0);
  const data = await ajaxCloudService.getHubLogs(hubId, pageSize, pageIndex);
  res.json({ data });
}));

router.get('/hubs/:hubId/rooms', wrap(async (req, res) => {
  res.json({ data: await ajaxCloudService.listRooms(safeParam('hubId', String(req.params.hubId))) });
}));

router.get('/hubs/:hubId/groups', wrap(async (req, res) => {
  res.json({ data: await ajaxCloudService.listGroups(safeParam('hubId', String(req.params.hubId))) });
}));

router.get('/objects', wrap(async (req, res) => {
  const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize) || 50));
  const pageIndex = Math.max(0, Number(req.query.pageIndex) || 0);
  res.json({ data: await ajaxCloudService.listObjects(pageSize, pageIndex) });
}));

router.get('/objects/:objectId', wrap(async (req, res) => {
  const oid = safeParam('objectId', String(req.params.objectId));
  res.json(await ajaxCloudService.getObject(oid));
}));

router.put('/hubs/:hubId/arm', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  const armed = req.body?.armed === true;
  res.json(await ajaxCloudService.armHub(hubId, armed));
}));
router.put('/hubs/:hubId/panic', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  res.json(await ajaxCloudService.panicHub(hubId));
}));
router.put('/hubs/:hubId/mute', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  res.json(await ajaxCloudService.muteHub(hubId));
}));

router.post('/hubs/:hubId/devices/:deviceId/photo', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  const deviceId = safeParam('deviceId', String(req.params.deviceId));
  const deviceType = typeof req.body?.deviceType === 'string' ? req.body.deviceType : undefined;
  try {
    const result = await ajaxCloudService.requestDevicePhoto(hubId, deviceId, deviceType);
    res.json({ ok: true, message: 'Foto solicitada. Llegara por SQS en unos segundos.', result });
  } catch (err) {
    const e = err as Error & { status?: number; userMessage?: string };
    const status = e.status || 500;
    res.status(status).json({
      error: 'photo_request_failed',
      message: e.userMessage || e.message || 'Error desconocido',
    });
  }
}));

router.get('/hubs/:hubId/monitoring', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  res.json(await ajaxCloudService.getHubMonitoring(hubId));
}));

router.get('/hubs/:hubId', wrap(async (req, res) => {
  const hubId = safeParam('hubId', String(req.params.hubId));
  const ar = req as import('express').Request & { user?: { sub: string; role?: string } };
  const allowedHubIds = await getAllowedHubIds(ar.user?.sub || '', (ar.user?.role || '').toUpperCase());
  if (allowedHubIds !== null && !allowedHubIds.includes(hubId)) { res.status(403).json({ error: 'no_access_to_hub' }); return; }
  res.json(await ajaxCloudService.getHub(hubId));
}));

router.get('/hubs/:hubId/devices', wrap(async (req, res) => {
  res.json({ data: await ajaxCloudService.listDevices(safeParam('hubId', String(req.params.hubId))) });
}));

router.get('/hubs/:hubId/devices/:deviceId', wrap(async (req, res) => {
  res.json(await ajaxCloudService.getDevice(safeParam('hubId', String(req.params.hubId)), safeParam('deviceId', String(req.params.deviceId))));
}));

router.get('/hubs/:hubId/users', wrap(async (req, res) => {
  res.json({ data: await ajaxCloudService.listHubUsers(safeParam('hubId', String(req.params.hubId))) });
}));

export default router;
