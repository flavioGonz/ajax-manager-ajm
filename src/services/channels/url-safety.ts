import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { URL } from 'url';

/**
 * SSRF guard para URLs de webhooks configuradas por el usuario.
 *
 * Bloquea:
 *  - schemes que no sean http/https
 *  - hostnames que resuelven a IPs privadas, loopback, link-local, broadcast, multicast
 *  - URLs con userinfo (user:pass@)
 *
 * Devuelve la URL validada (string) o lanza Error.
 */

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return false;

  if (v === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    const [a, b] = parts;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8 loopback
    if (a === 127) return true;
    // 169.254.0.0/16 link-local (AWS/GCP metadata)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 100.64.0.0/10 CGNAT (operadores)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 224.0.0.0/4 multicast
    if (a >= 224 && a <= 239) return true;
    // 255.255.255.255 broadcast
    if (a === 255 && b === 255) return true;
    return false;
  }

  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower === '::') return true; // unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped IPv6
      const v4 = lower.split(':').pop() || '';
      return isPrivateIp(v4);
    }
    return false;
  }
  return false;
}

export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`url_scheme_not_allowed: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error('url_with_userinfo_blocked');
  }
  const host = u.hostname;
  if (!host) throw new Error('url_no_host');

  // Si ya es IP, validar directo
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`private_ip_blocked: ${host}`);
    return u;
  }

  // Resolver DNS
  try {
    const records = await lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new Error(`hostname_resolves_to_private_ip: ${host} -> ${r.address}`);
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('hostname_resolves')) throw err;
    throw new Error(`dns_resolve_failed: ${msg}`);
  }
  return u;
}
