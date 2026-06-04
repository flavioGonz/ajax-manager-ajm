import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import http from 'http';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { authRequired, requireAdmin } from './middlewares/auth.middleware';
import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import eventsRoutes from './routes/events.routes';
import subscriptionsRoutes from './routes/subscriptions.routes';
import systemRoutes from './routes/system.routes';
import ajaxRoutes from './routes/ajax.routes';
import pushRoutes from './routes/push.routes';
import clientsRoutes from './routes/clients.routes';
import deviceImagesRoutes from './routes/device-images.routes';
import { createBullBoardRouter } from './routes/bull-board';
import { attachSocketIO } from '../realtime/socket';

export function createServer(): { app: express.Express; httpServer: http.Server } {
  const app = express();
  app.set('trust proxy', 1);
  app.use(compression({ threshold: 1024 }));
  app.use(
    helmet({
      strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: false },
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      originAgentCluster: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://unpkg.com'],
          'connect-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org', 'ws:', 'wss:'],
          'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '4mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' || req.url?.startsWith('/socket.io') },
    }),
  );
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ajax-manager-ajm', timestamp: new Date().toISOString() });
  });
  app.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const redisOk = (await redis.ping()) === 'PONG';
      if (!redisOk) throw new Error('redis ping failed');
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not-ready', error: (err as Error).message });
    }
  });
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  const publicDir = path.resolve(process.cwd(), 'public');
  const imagesDir = process.env.DEVICE_IMAGES_DIR || '/app/data/device-images';
  try { require('fs').mkdirSync(imagesDir, { recursive: true }); } catch { /* ignore */ }
  app.use('/device-images', express.static(imagesDir, { maxAge: '5m', fallthrough: true }));

  app.use('/dashboard', express.static(publicDir, {
    index: 'index.html',
    setHeaders: (res, p) => {
      if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (/\.(svg|png|jpg|ico)$/.test(p)) res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }));
  app.get('/', (_req, res) => res.redirect('/dashboard'));
  app.use('/api/auth', apiLimiter, authRoutes);
  app.use('/api/users', apiLimiter, usersRoutes);
  app.use('/api/events', apiLimiter, authRequired, eventsRoutes);
  app.use('/api/subscriptions', apiLimiter, authRequired, subscriptionsRoutes);
  app.use('/api/system', apiLimiter, authRequired, systemRoutes);
  app.use('/api/system/device-images', apiLimiter, authRequired, deviceImagesRoutes);
  app.use('/api/ajax', apiLimiter, authRequired, ajaxRoutes);
  app.use('/api/push', apiLimiter, authRequired, pushRoutes);
  app.use('/api/clients', apiLimiter, authRequired, clientsRoutes);
  app.use('/admin/queues', authRequired, requireAdmin, createBullBoardRouter());
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message }, 'Unhandled error en API');
    res.status(500).json({ error: 'internal_error' });
  });
  const httpServer = http.createServer(app);
  attachSocketIO(httpServer);
  return { app, httpServer };
}

export function startApiServer(): http.Server {
  const { httpServer } = createServer();
  httpServer.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API HTTP + Socket.io escuchando');
  });
  return httpServer;
}

if (require.main === module) {
  startApiServer();
}
