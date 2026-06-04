import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import { config, hasUserAuth } from '../config';
import { logger } from '../utils/logger';

/**
 * Auth con Ajax Enterprise API.
 *
 * RECOMENDADO: Company API (auth=`X-Api-Key` + `X-Company-Token`, ambos estaticos).
 * No requiere login/password. Es lo que usan empresas de monitoreo/CRA.
 *
 * LEGACY: User API (login + sha256(password) -> sessionToken 15min).
 * Solo para usuarios end-user con la app movil. NO funciona con cuentas PRO.
 *
 * Esta clase mantiene la User API para retrocompatibilidad pero el cliente
 * axios prioriza X-Company-Token cuando esta presente.
 */
export class AjaxAuthService {
  private sessionToken: string | null = null;
  private userId: string | null = null;
  private refreshToken: string | null = null;
  private sessionExpiresAt: number | null = null;
  private inflight: Promise<string> | null = null;
  private readonly httpClient: AxiosInstance;
  private static readonly SESSION_TTL_MS = 14 * 60 * 1000;

  constructor() {
    this.httpClient = axios.create({
      baseURL: config.AJAX_API_BASE_URL,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.X_API_KEY },
    });
  }

  private hashPassword(plain: string): string {
    return createHash('sha256').update(plain, 'utf8').digest('hex');
  }

  /** Devuelve sessionToken si User API esta configurada. Sino, null. */
  async getToken(): Promise<string | null> {
    if (!hasUserAuth) return null;
    if (this.sessionToken && this.sessionExpiresAt && Date.now() < this.sessionExpiresAt) {
      return this.sessionToken;
    }
    return this.acquireToken();
  }

  async forceRefresh(): Promise<string | null> {
    if (!hasUserAuth) return null;
    this.sessionToken = null;
    this.sessionExpiresAt = null;
    return this.acquireToken();
  }

  getUserId(): string | null { return this.userId; }

  private async acquireToken(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        if (this.refreshToken && this.userId) {
          try { return await this.tryRefresh(); } catch (err) {
            logger.warn({ err: (err as Error).message }, 'Refresh fallo - login completo');
          }
        }
        return await this.tryLogin();
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  private async tryLogin(): Promise<string> {
    const res = await this.httpClient.post('/api/login', {
      login: config.AJAX_LOGIN,
      passwordHash: this.hashPassword(config.AJAX_PASSWORD),
    });
    const { sessionToken, userId, refreshToken } = res.data ?? {};
    if (!sessionToken || !userId) throw new Error('Login Ajax sin token/userId');
    this.sessionToken = sessionToken;
    this.userId = userId;
    this.refreshToken = refreshToken ?? null;
    this.sessionExpiresAt = Date.now() + AjaxAuthService.SESSION_TTL_MS;
    logger.info({ userId }, 'Login Ajax (User API) exitoso');
    return sessionToken;
  }

  private async tryRefresh(): Promise<string> {
    const res = await this.httpClient.post('/api/refresh', {
      userId: this.userId, refreshToken: this.refreshToken,
    });
    const { sessionToken, userId, refreshToken } = res.data ?? {};
    if (!sessionToken) throw new Error('Refresh Ajax sin sessionToken');
    this.sessionToken = sessionToken;
    this.userId = userId ?? this.userId;
    this.refreshToken = refreshToken ?? this.refreshToken;
    this.sessionExpiresAt = Date.now() + AjaxAuthService.SESSION_TTL_MS;
    return sessionToken;
  }
}

export const ajaxAuthService = new AjaxAuthService();
