import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { config, hasCompanyAuth, hasUserAuth } from '../config';
import { logger } from '../utils/logger';
import { ajaxAuthService } from './ajax-auth.service';
import { pushDebug, redactHeaders, redactUrl } from '../utils/debug-log';

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
  _rateLimitRetry?: number;
}

/**
 * Cliente axios contra Ajax Enterprise API.
 *
 * Auth:
 *  - Si hay Company auth (X-Company-Token + companyId): usa esos headers estaticos.
 *  - Si solo hay User auth (login/password): sessionToken con auto-refresh.
 *
 * Rate limit (segun doc: 100 req/min/X-Api-Key):
 *  - Si recibimos 429, esperamos lo que indique Retry-After (o backoff exponencial)
 *    y reintentamos hasta 3 veces. Esto evita que penalicen la cuenta.
 *
 * 401:
 *  - Refresh automatico del sessionToken (solo en User API). Reintento UNICO.
 */

const RATE_LIMIT_MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 5000;

let lastRateLimitHitAt = 0;
let rateLimitedUntil = 0;

/** Si fuimos rate-limited recientemente, hold off para no martillar mas. */
async function maybeWaitForRateLimit(): Promise<void> {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const waitMs = rateLimitedUntil - now;
    logger.debug({ waitMs }, 'Esperando ventana rate-limit Ajax antes de la request');
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function handleRateLimit(error: AxiosError, original: RetryableConfig, client: AxiosInstance): Promise<unknown> {
  const retryAfterHeader = error.response?.headers?.['retry-after'];
  const retryAfterMs = retryAfterHeader ? Math.min(60_000, parseInt(String(retryAfterHeader), 10) * 1000) : DEFAULT_RETRY_AFTER_MS;
  // Backoff exponencial sobre _rateLimitRetry
  const attempt = (original._rateLimitRetry ?? 0) + 1;
  if (attempt > RATE_LIMIT_MAX_RETRIES) {
    logger.warn({ attempt }, 'Rate limit Ajax: agotamos reintentos, propagando 429');
    throw error;
  }
  const delay = Math.min(60_000, retryAfterMs * Math.pow(1.5, attempt - 1));
  rateLimitedUntil = Date.now() + delay;
  lastRateLimitHitAt = Date.now();
  logger.warn({ attempt, delayMs: delay, url: original.url }, 'Rate limit Ajax (429): esperando y reintentando');
  await new Promise((r) => setTimeout(r, delay));
  original._rateLimitRetry = attempt;
  return client.request(original);
}

function buildClient(): AxiosInstance {
  const client = axios.create({
    baseURL: config.AJAX_API_BASE_URL,
    timeout: 20_000,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.X_API_KEY,
    },
  });

  // Debug log: timestamp del start de cada request para medir duracion
  client.interceptors.request.use((cfg) => {
    (cfg as { _startTs?: number })._startTs = Date.now();
    return cfg;
  });
  // Pre-request: si fuimos rate-limited, esperar la ventana antes de mandar mas requests
  client.interceptors.request.use(async (cfg) => {
    await maybeWaitForRateLimit();
    return cfg;
  });

  if (hasCompanyAuth) {
    client.interceptors.request.use(async (cfg) => {
      cfg.headers.set('X-Company-Token', config.AJAX_COMPANY_TOKEN);
      return cfg;
    });
    logger.info('Ajax client: Company API mode (X-Company-Token)');
  } else if (hasUserAuth) {
    client.interceptors.request.use(async (cfg) => {
      const token = await ajaxAuthService.getToken();
      if (token) cfg.headers.set('X-Session-Token', token);
      return cfg;
    });
    logger.info('Ajax client: User API mode (X-Session-Token con refresh)');
  } else {
    logger.warn('Ajax client: SIN auth configurada - llamadas a Ajax Cloud van a fallar');
  }

  // Response interceptor: maneja 401 (refresh) y 429 (rate limit) + debug log
  client.interceptors.response.use(
    (response) => {
      const cfg = response.config as InternalAxiosRequestConfig & { _startTs?: number };
      const dur = cfg._startTs ? Date.now() - cfg._startTs : undefined;
      pushDebug({
        source: 'ajax-http',
        level: 'info',
        direction: 'in',
        method: (cfg.method || 'GET').toUpperCase(),
        url: redactUrl(cfg.url),
        status: response.status,
        durationMs: dur,
        message: `${(cfg.method||'').toUpperCase()} ${redactUrl(cfg.url)} → ${response.status} (${dur}ms)`,
        meta: { headers: redactHeaders(response.headers as Record<string, unknown>) },
      });
      return response;
    },
    async (error: AxiosError) => {
      const cfg = error.config as (InternalAxiosRequestConfig & { _startTs?: number }) | undefined;
      const dur = cfg?._startTs ? Date.now() - cfg._startTs : undefined;
      pushDebug({
        source: 'ajax-http',
        level: error.response && error.response.status >= 500 ? 'error' : (error.response?.status === 429 ? 'warn' : 'error'),
        direction: 'in',
        method: (cfg?.method || 'GET').toUpperCase(),
        url: redactUrl(cfg?.url),
        status: error.response?.status,
        durationMs: dur,
        message: `${(cfg?.method||'').toUpperCase()} ${redactUrl(cfg?.url)} → ERROR ${error.response?.status || 'network'}`,
        errorMessage: error.message,
        meta: { responseBody: typeof error.response?.data === 'string' ? error.response.data.slice(0, 500) : error.response?.data },
      });
      const original = error.config as RetryableConfig | undefined;
      if (!original) return Promise.reject(error);
      const status = error.response?.status;

      // 429: rate limit hit
      if (status === 429) {
        return handleRateLimit(error, original, client);
      }

      // 401: refresh token (solo User API)
      if (status === 401 && !original._retry && hasUserAuth) {
        logger.warn({ url: original.url }, '401 Ajax - reintentando con token nuevo');
        original._retry = true;
        try {
          const t = await ajaxAuthService.forceRefresh();
          if (t) original.headers.set('X-Session-Token', t);
          return client.request(original);
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return Promise.reject(error);
    },
  );

  return client;
}

export const ajaxApiClient = buildClient();

/** Stats para diagnostico */
export function getAjaxClientStats() {
  return {
    rateLimitedUntil,
    lastRateLimitHitAt,
    isRateLimited: rateLimitedUntil > Date.now(),
  };
}
