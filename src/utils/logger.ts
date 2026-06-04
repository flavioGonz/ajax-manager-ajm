import pino from 'pino';
import { config, isDev } from '../config';

/**
 * Logger global con redacción automática de datos sensibles.
 *
 * IMPORTANTE: Por las consideraciones de privacidad del proyecto NO se imprimen
 * payloads completos que puedan contener datos personales de usuarios finales
 * de las alarmas. Si necesitás loggear un payload, usá `logger.debug` y filtrá
 * los campos sensibles antes.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  // Transport sólo en desarrollo - en producción usamos JSON estructurado
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
  redact: {
    paths: [
      // Headers de auth
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["x-session-token"]',
      'headers.authorization',
      'headers["x-api-key"]',
      'headers["x-session-token"]',
      // Credenciales en bodies
      'password',
      'login',
      '*.password',
      '*.login',
      '*.apiKey',
      '*.sessionToken',
      '*.secret',
      'config.X_API_KEY',
      'config.AJAX_PASSWORD',
      'config.AWS_SECRET_ACCESS_KEY',
      'config.API_KEY_DASHBOARD',
      // Datos personales que pudieran venir en payloads de alarmas
      '*.phone',
      '*.email',
      '*.userName',
      '*.userEmail',
      '*.userPhone',
      '*.address',
      '*.coordinates',
    ],
    censor: '[REDACTED]',
    remove: false,
  },
  base: {
    service: 'ajax-manager-ajm',
    env: config.NODE_ENV,
  },
});

/**
 * Helper para resumir un payload de Ajax sin exponer información sensible.
 * Devuelve sólo metadatos útiles para depuración.
 */
export function summarizeAjaxPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return { type: typeof payload };
  }
  const p = payload as Record<string, unknown>;
  return {
    eventId: p.eventId ?? p.id,
    hubId: p.hubId ?? p.objectId,
    eventCode: p.eventCode ?? p.cid ?? p.sia,
    protocol: p.protocol,
    timestamp: p.timestamp ?? p.occurredAt,
    hasPayload: true,
  };
}
