import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';

const SALT_ROUNDS = 10;
const REVOKED_PREFIX = 'ajm:revoked:';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  jti: string;
}

export class AuthService {
  /** Hashea un password con bcrypt. */
  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** Login con email + password. Devuelve un JWT o null si invalido. */
  async login(email: string, password: string): Promise<{ token: string; user: SafeUser } | null> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.active) return null;

    const ok = await this.verifyPassword(password, user.passwordHash);
    if (!ok) return null;

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = this.signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      jti: crypto.randomUUID(),
    });

    return { token, user: toSafeUser(user) };
  }

  signToken(payload: Omit<JwtPayload, 'jti'> & { jti?: string }): string {
    const fullPayload = { ...payload, jti: payload.jti ?? crypto.randomUUID() };
    return jwt.sign(fullPayload, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
      algorithm: 'HS256',
    } as SignOptions);
  }

  /**
   * Verifica un JWT. Tira si esta vencido, mal firmado o revocado.
   */
  async verifyToken(token: string): Promise<JwtPayload> {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
    // Check revoked list
    const isRevoked = await redis.get(REVOKED_PREFIX + payload.jti);
    if (isRevoked) throw new Error('Token revocado');
    return payload;
  }

  /**
   * Revoca un JWT (logout). Lo guardamos en Redis con TTL = duracion restante.
   */
  async revokeToken(token: string, expectedJti?: string): Promise<boolean> {
    try {
      // verify (no decode) para confirmar firma + algoritmo HS256
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as (JwtPayload & { exp?: number });
      if (!payload || !payload.jti) return false;
      // Si vino un jti esperado (logueado), validar match para evitar revocar tokens ajenos
      if (expectedJti && payload.jti !== expectedJti) {
        logger.warn({ jti: payload.jti, expected: expectedJti }, 'revokeToken: jti mismatch');
        return false;
      }
      const ttlSec = payload.exp ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000)) : 86400;
      await redis.set(REVOKED_PREFIX + payload.jti, '1', 'EX', ttlSec);
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'No se pudo revocar token (firma invalida o expirado)');
      return false;
    }
  }

  /** Cambia password del usuario tras verificar el actual. */
  async changePassword(userId: string, oldPass: string, newPass: string): Promise<boolean> {
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (!u) return false;
    const ok = await this.verifyPassword(oldPass, u.passwordHash);
    if (!ok) return false;
    const hash = await this.hashPassword(newPass);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });
    return true;
  }
}

export interface SafeUser {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toSafeUser<T extends { id: string; email: string; fullName: string | null; role: UserRole; active: boolean; lastLoginAt: Date | null; createdAt: Date }>(u: T): SafeUser {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export const authService = new AuthService();
