/**
 * Smoke test: valida que podemos hacer login contra la API REST de Ajax
 * y obtener un X-Session-Token válido.
 *
 * Uso:
 *   npx tsx scripts/test-ajax-auth.ts
 *
 * El script prueba varios paths candidatos para el endpoint de login porque
 * Ajax cambia el prefijo según versión de su API Enterprise. El primero que
 * responda 200 con un token gana — y ese path lo dejamos en
 * src/services/ajax-auth.service.ts (`LOGIN_PATH`).
 *
 * Sólo imprime metadatos seguros (status, headers existentes) — NO imprime
 * el password ni el token completo.
 */
import 'dotenv/config';
import axios, { AxiosError } from 'axios';

const BASE = process.env.AJAX_API_BASE_URL ?? 'https://enterprise-api.ajax.systems';
const API_KEY = process.env.X_API_KEY ?? '';
const LOGIN = process.env.AJAX_LOGIN ?? '';
const PASSWORD = process.env.AJAX_PASSWORD ?? '';
const INT_ID = process.env.AJAX_INT_ID ?? '';

const CANDIDATE_PATHS = [
  '/api/integrations/login',
  `/api/integrations/${INT_ID}/login`,
  '/api/login',
  '/v1/login',
  '/api/v1/integrations/login',
];

function maskToken(t: string | null): string {
  if (!t) return '(vacío)';
  if (t.length <= 8) return '***';
  return `${t.slice(0, 4)}...${t.slice(-4)} (len=${t.length})`;
}

async function tryLogin(path: string): Promise<{ ok: boolean; token: string | null; status: number | null; note: string }> {
  try {
    const url = `${BASE}${path}`;
    const res = await axios.post(
      url,
      { login: LOGIN, password: PASSWORD },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': API_KEY,
        },
        timeout: 15_000,
        validateStatus: () => true, // queremos ver todos los status
      },
    );

    const fromHeader =
      (res.headers['x-session-token'] as string | undefined) ??
      (res.headers['X-Session-Token'] as string | undefined);
    const fromBody =
      (res.data?.sessionToken as string | undefined) ??
      (res.data?.token as string | undefined) ??
      (res.data?.X_Session_Token as string | undefined);

    const token = (fromHeader ?? fromBody) ?? null;

    if (res.status >= 200 && res.status < 300 && token) {
      return { ok: true, token, status: res.status, note: 'OK' };
    }
    return {
      ok: false,
      token: null,
      status: res.status,
      note: `status=${res.status} ${typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : ''}`,
    };
  } catch (err) {
    const ax = err as AxiosError;
    return {
      ok: false,
      token: null,
      status: ax.response?.status ?? null,
      note: ax.message,
    };
  }
}

async function main(): Promise<void> {
  console.log('🔐 Ajax Auth smoke test');
  console.log(`Base URL : ${BASE}`);
  console.log(`Login    : ${LOGIN}`);
  console.log(`API Key  : ${API_KEY ? maskToken(API_KEY) : '(vacía)'}`);
  console.log(`Int ID   : ${INT_ID}`);
  console.log('');

  if (!LOGIN || !PASSWORD || !API_KEY) {
    console.error('❌ Faltan variables de entorno: revisá .env (AJAX_LOGIN, AJAX_PASSWORD, X_API_KEY)');
    process.exit(1);
  }

  for (const path of CANDIDATE_PATHS) {
    process.stdout.write(`→ Probando ${path}  ... `);
    const r = await tryLogin(path);
    if (r.ok) {
      console.log(`✅ OK  token=${maskToken(r.token)}`);
      console.log('');
      console.log(`👉 Actualizá LOGIN_PATH en src/services/ajax-auth.service.ts a: '${path}'`);
      process.exit(0);
    } else {
      console.log(`✗ ${r.note}`);
    }
  }

  console.error('');
  console.error('❌ Ningún path candidato funcionó. Posibles causas:');
  console.error('  - X_API_KEY incorrecta o no asociada a este AJAX_INT_ID');
  console.error('  - login/password inválidos');
  console.error('  - AJAX_API_BASE_URL distinto al esperado (revisá la doc de tu integrador)');
  console.error('');
  console.error('Pegá la documentación o un curl de ejemplo de Ajax y agrego el path correcto.');
  process.exit(1);
}

main().catch((err) => {
  console.error('Fallo inesperado:', err.message);
  process.exit(1);
});
