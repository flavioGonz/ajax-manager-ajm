import IORedis, { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

/**
 * Conexión Redis compartida. BullMQ requiere `maxRetriesPerRequest: null`
 * para conexiones de Workers (de lo contrario tira ECONNRESET ruidosos).
 */
export function createRedisConnection(): Redis {
  const conn = new IORedis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  conn.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });
  conn.on('connect', () => {
    logger.info({ host: config.REDIS_HOST, port: config.REDIS_PORT }, 'Redis connected');
  });

  return conn;
}

export const redis = createRedisConnection();
