import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import type { Request } from 'express';

/**
 * Registra una accion en la tabla audit_logs.
 * Es secundario al flow — si falla, lo ignoramos.
 */
export async function audit(
  req: Request | null,
  action: string,
  options: {
    userId?: string | null;
    resource?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const reqUser = (req as { user?: { sub: string } } | null)?.user;
    await prisma.auditLog.create({
      data: {
        userId: options.userId ?? reqUser?.sub ?? null,
        action,
        resource: options.resource ?? null,
        metadata: options.metadata ? (options.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
        ipAddress: req?.ip ?? null,
        userAgent: req?.headers?.['user-agent']?.toString().slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, action }, 'audit log fallido');
  }
}
