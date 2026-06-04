import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { authService, JwtPayload } from '../services/auth.service';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Servidor Socket.io para push de eventos en vivo al dashboard.
 *
 * Auth: JWT del dashboard via handshake (auth: { token }).
 * El service token (API_KEY_DASHBOARD) tambien es aceptado para integraciones.
 *
 * Salas (rooms):
 *   - role:VIEWER, role:OPERATOR, role:ADMIN: cada user entra a su sala segun rol
 *   - hub:{hubId}: clientes pueden suscribirse a eventos de un hub especifico
 *
 * Eventos del servidor al cliente:
 *   - event:new      - cuando llega un evento nuevo
 *   - alarm:new      - cuando llega un evento severity=ALARM (UI especial)
 *   - delivery:new   - cuando se crea un delivery
 *   - delivery:done  - cuando un delivery termina (succeeded/failed)
 *   - hub:status     - cambio de estado online/offline de un hub (futuro)
 *
 * Eventos del cliente al servidor:
 *   - subscribe:hub  - suscribirse a un hub especifico
 *   - unsubscribe:hub
 */

interface SocketAuth { token?: string; }
interface AuthedSocket extends Socket {
  data: { user?: JwtPayload; isService?: boolean };
}

import { onDebugEntry } from '../utils/debug-log';

let io: SocketIOServer | null = null;

// Reenvia cada debug entry a las salas role:OPERATOR/ADMIN
let _debugListenerBound = false;

export function attachSocketIO(httpServer: HttpServer): SocketIOServer {
  if (!_debugListenerBound) {
    _debugListenerBound = true;
    onDebugEntry((entry) => {
      try {
        if (io) {
          io.to('role:ADMIN').to('role:OPERATOR').emit('debug:entry', entry);
        }
      } catch {}
    });
  }

  io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: { origin: false }, // mismo origen
    // Polling y websocket. WS es preferido pero pollig sirve detras de proxies viejos.
    transports: ['polling', 'websocket'],
    pingInterval: 20_000,
    pingTimeout: 25_000,
  });

  io.use(async (socket: AuthedSocket, next) => {
    try {
      const auth = socket.handshake.auth as SocketAuth;
      const token = auth?.token || (socket.handshake.headers['authorization'] || '').toString().replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('missing_token'));

      // Service token aceptado
      if (token === config.API_KEY_DASHBOARD) {
        socket.data.isService = true;
        return next();
      }
      // JWT humano
      const payload = await authService.verifyToken(token);
      socket.data.user = payload;
      next();
    } catch (e) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const u = socket.data.user;
    if (u) {
      socket.join(`role:${u.role}`);
      socket.join(`user:${u.sub}`);
    } else if (socket.data.isService) {
      socket.join('role:ADMIN');
    }
    logger.info({ sid: socket.id, user: u?.email ?? '(service)' }, 'socket connected');

    socket.on('subscribe:hub', (hubId: string) => {
      if (typeof hubId === 'string' && hubId.length < 100) socket.join(`hub:${hubId}`);
    });
    socket.on('unsubscribe:hub', (hubId: string) => {
      if (typeof hubId === 'string') socket.leave(`hub:${hubId}`);
    });
    socket.on('disconnect', () => {
      logger.debug({ sid: socket.id }, 'socket disconnected');
    });
  });

  logger.info('Socket.io attached at /socket.io');
  return io;
}

/** Helpers para emitir desde otros modulos (event-processor, dispatcher). */
export function emitEventNew(event: Record<string, unknown>): void {
  if (!io) return;
  io.to('role:VIEWER').to('role:OPERATOR').to('role:ADMIN').emit('event:new', event);
  if (event.severity === 'ALARM') {
    io.to('role:VIEWER').to('role:OPERATOR').to('role:ADMIN').emit('alarm:new', event);
  }
  if (typeof event.hubId === 'string' && event.hubId) {
    io.to(`hub:${event.hubId}`).emit('event:new', event);
  }
}

export function emitDeliveryUpdate(delivery: Record<string, unknown>): void {
  if (!io) return;
  io.to('role:OPERATOR').to('role:ADMIN').emit('delivery:update', delivery);
}

export function getIO(): SocketIOServer | null { return io; }
