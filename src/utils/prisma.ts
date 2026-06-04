import { PrismaClient } from '@prisma/client';
import { isProd } from '../config';

/**
 * Singleton de PrismaClient. En desarrollo guardamos la instancia en globalThis
 * para evitar crear múltiples conexiones cuando hot-reload reimporta este módulo.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    log: isProd ? ['error', 'warn'] : ['warn', 'error'],
  });

if (!isProd) {
  globalThis.__prisma = prisma;
}
