import { config as dotenvConfig } from 'dotenv';
// override:true => dotenv siempre prevalece sobre lo que Docker inyecte via env_file.
// Esto permite editar el .env (montado como bind) y reiniciar el container con un simple
// restart para tomar los cambios, sin necesidad de docker compose up -d --force-recreate.
dotenvConfig({ override: true });
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_KEY_DASHBOARD: z.string().min(8),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  // Web Push (VAPID) - opcional, si no estan definidos las push notif quedan deshabilitadas
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:desarrollo@favaro.com.uy'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  AJAX_INT_ID: z.string().min(1),
  AJAX_API_BASE_URL: z.string().url().default('https://api.ajax.systems'),
  X_API_KEY: z.string().min(1),
  AJAX_COMPANY_TOKEN: z.string().optional().default(''),
  AJAX_COMPANY_ID: z.string().optional().default(''),
  AJAX_LOGIN: z.string().optional().default(''),
  AJAX_PASSWORD: z.string().optional().default(''),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_URL: z.string().url(),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  SQS_VISIBILITY_TIMEOUT: z.coerce.number().int().positive().default(60),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  WEBHOOK_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WEBHOOK_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(2000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DEMO_MODE: z.string().optional().default('false').transform((v) => /^(true|1|yes|on)$/i.test(String(v).trim())),
  DEMO_INTERVAL_SEC: z.coerce.number().int().positive().default(20),
  OPC_ENABLED: z.string().optional().default('false').transform((v) => /^(true|1|yes|on)$/i.test(String(v).trim())),
  OPC_PORT: z.coerce.number().int().positive().default(4840),
  OPC_RESOURCE_PATH: z.string().default('/UA/AJM'),
  OPC_APPLICATION_URI: z.string().default('urn:ies:ajm:opcua-server'),
  OPC_SERVER_NAME: z.string().default('AJM OPC UA Server'),
  OPC_USERNAME: z.string().optional().default(''),
  OPC_PASSWORD: z.string().optional().default(''),
  OPC_CLIENT_ENABLED: z.string().optional().default('false').transform((v) => /^(true|1|yes|on)$/i.test(String(v).trim())),
  OPC_CLIENT_ENDPOINT_URL: z.string().optional().default(''),
  OPC_CLIENT_USERNAME: z.string().optional().default(''),
  OPC_CLIENT_PASSWORD: z.string().optional().default(''),
  OPC_CLIENT_NODE_TEMPLATE: z.string().default('ns=2;s=AJM/{hubId}/{var}'),
  OPC_CLIENT_RECONNECT_MS: z.coerce.number().int().positive().default(15000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Configuracion invalida:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const hasPush = (): boolean => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
export const isDev = config.NODE_ENV === 'development';
export const hasCompanyAuth = !!(config.AJAX_COMPANY_TOKEN && config.AJAX_COMPANY_ID);
export const hasUserAuth = !!(config.AJAX_LOGIN && config.AJAX_PASSWORD);
