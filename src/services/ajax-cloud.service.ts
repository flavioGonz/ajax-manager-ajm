import { ajaxApiClient } from './ajax-api.client';
import { ajaxAuthService } from './ajax-auth.service';
import { config, hasCompanyAuth } from '../config';
import { redis } from '../utils/redis';

// Helper: ejecutar fn(item) sobre cada item con concurrency limit (semaforo).
async function mapLimit<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Wrappers tipados sobre Ajax Enterprise API.
 * Caches en Redis 30s para no martillar la API (rate-limit 100/min).
 */

const CACHE_TTL_SEC = 30;
const CACHE_PREFIX = 'ajm:ajax:';

async function cached<T>(key: string, fetcher: () => Promise<T>, ttl = CACHE_TTL_SEC): Promise<T> {
  const k = CACHE_PREFIX + key;
  try {
    const hit = await redis.get(k);
    if (hit) return JSON.parse(hit) as T;
  } catch {/* ignore */}
  const fresh = await fetcher();
  try { await redis.set(k, JSON.stringify(fresh), 'EX', ttl); } catch {/* ignore */}
  return fresh;
}

export interface AjaxHubSummary {
  hubId: string;
  name?: string;
  online?: boolean;
  lastSeen?: string;
  firmware?: string;
  // Enriched fields
  state?: string;             // 'DISARMED', 'ARMED', 'DISARMED_NIGHT_MODE_OFF', etc
  tampered?: boolean | null;
  hubSubtype?: string;
  ethernetEnabled?: boolean;
  ethernetIp?: string;
  gsmEnabled?: boolean;
  gsmSignal?: number | null;
  wifiEnabled?: boolean;
  noiseHigh?: boolean;
  batteryPct?: number | null;
  externallyPowered?: boolean | null;
  devicesCount?: number;
  raw: Record<string, unknown>;
}

export class AjaxCloudService {
  async listHubs(): Promise<{ source: 'company' | 'user'; data: AjaxHubSummary[] }> {
    if (hasCompanyAuth) {
      const data = await this.listCompanyHubs(config.AJAX_COMPANY_ID);
      return { source: 'company', data };
    }
    const data = await this.listUserHubs();
    return { source: 'user', data };
  }

  async listCompanyHubs(companyId: string): Promise<AjaxHubSummary[]> {
    // Cache mas largo (60s) porque hacemos N+1 calls para enriquecer con nombres.
    return cached(`company:${companyId}:hubs:enriched`, async () => {
      const res = await ajaxApiClient.get(`/api/company/${companyId}/hubs`, {
        params: { limit: 200, offset: 0 },
      });
      const list = Array.isArray(res.data) ? res.data : (res.data?.items ?? res.data?.hubs ?? []);
      // Lista flat trae solo {hubId, a911ChannelState, translatorChannelState, ...}.
      // Para mostrar nombre + IP + señales + contador de sensores, hacemos GET detalle + GET devices
      // en paralelo por hub con concurrency limitada (rate-limit Ajax 100req/min).
      const enriched = await mapLimit(list, 5, async (h: Record<string, unknown>): Promise<AjaxHubSummary> => {
        const hubId = (h.id ?? h.hubId ?? '') as string;
        const flat = toHubSummary(h);
        if (!hubId) return flat;
        try {
          const [det, devs] = await Promise.all([
            this.getHub(hubId) as Promise<Record<string, unknown>>,
            this.listDevices(hubId).catch(() => [] as unknown[]),
          ]);
          const merged = toHubSummary({ ...h, ...det });
          merged.devicesCount = Array.isArray(devs) ? devs.length : 0;
          return merged;
        } catch {
          return flat;
        }
      });
      return enriched;
    }, 60);
  }

  async listUserHubs(): Promise<AjaxHubSummary[]> {
    let userId = ajaxAuthService.getUserId();
    if (!userId) { await ajaxAuthService.getToken(); userId = ajaxAuthService.getUserId(); }
    if (!userId) throw new Error('No hay userId (User API). Configura AJAX_COMPANY_TOKEN y AJAX_COMPANY_ID para usar Company API.');
    return cached(`user:${userId}:hubs`, async () => {
      const res = await ajaxApiClient.get(`/api/user/${userId}/hubs`);
      const list = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
      return list.map(toHubSummary);
    });
  }

  private hubBasePath(hubId: string): string {
    if (hasCompanyAuth) return `/api/company/${config.AJAX_COMPANY_ID}/hubs/${hubId}`;
    const userId = ajaxAuthService.getUserId();
    return `/api/user/${userId}/hubs/${hubId}`;
  }

  async getHub(hubId: string): Promise<unknown> {
    return cached(`hub:${hubId}`, async () => (await ajaxApiClient.get(this.hubBasePath(hubId))).data);
  }

  async listDevices(hubId: string): Promise<unknown[]> {
    return cached(`hub:${hubId}:devices`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/devices');
      return Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
    });
  }

  async getDevice(hubId: string, deviceId: string): Promise<unknown> {
    return cached(`hub:${hubId}:device:${deviceId}`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/devices/' + deviceId);
      return res.data;
    });
  }

  async listHubUsers(hubId: string): Promise<unknown[]> {
    return cached(`hub:${hubId}:users`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/users');
      return Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
    });
  }

  /**
   * Lista TODOS los usuarios cross-hub de la company.
   * Itera todos los hubs (con cache de 60s) y para cada uno lista usuarios (concurrency 5).
   * Devuelve usuarios "aplanados" con info del hub al que pertenecen.
   */
  async listAllClients(): Promise<Array<Record<string, unknown>>> {
    if (!hasCompanyAuth) return [];
    const cacheKey = `company:${config.AJAX_COMPANY_ID}:all_clients`;
    return cached(cacheKey, async () => {
      const hubs = await this.listCompanyHubs(config.AJAX_COMPANY_ID);
      type FlatClient = Record<string, unknown>;
      const all: FlatClient[] = [];
      await mapLimit(hubs, 5, async (h: AjaxHubSummary): Promise<void> => {
        try {
          const usersList = await this.listHubUsers(h.hubId);
          for (const u of usersList as Array<Record<string, unknown>>) {
            all.push({
              userId: u.id || u.userId,
              firstName: u.firstName || u.name || u.fullName || '(sin nombre)',
              hubBindingRole: u.hubBindingRole || u.role || 'USER',
              keypadPrefix: u.keypadPrefix || null,
              hubId: h.hubId,
              hubName: h.name || h.hubId,
              hubSubtype: (h.raw && (h.raw as Record<string, unknown>).hubSubtype) || 'UNKNOWN',
              hubOnline: h.online ?? null,
              raw: u,
            });
          }
        } catch (_e) { /* skip hubs that fail */ }
      });
      return all;
    }, 60);
  }

  /**
   * Lista TODOS los sensores cross-hub enriquecidos con:
   *  - hubId, hubName, hubSubtype
   *  - deviceId, deviceName, deviceType, online, malfunctions, state
   *  - roomName (del room del hub)
   *  - groupName (del grupo del hub)
   *  - objectName, objectRegistrationNumber (del object/facility)
   *  - hasAlerts: boolean (malfunctions > 0 || tampered)
   */
  async listAllSensors(): Promise<Array<Record<string, unknown>>> {
    if (!hasCompanyAuth) return [];
    const cacheKey = `company:${config.AJAX_COMPANY_ID}:all_sensors`;
    return cached(cacheKey, async () => {
      const [hubs, objects] = await Promise.all([
        this.listCompanyHubs(config.AJAX_COMPANY_ID),
        this.listObjects(500, 0).catch(() => [] as unknown[]),
      ]);
      // Mapeo hubId -> object
      const objByHub = new Map<string, Record<string, unknown>>();
      for (const o of objects as Array<Record<string, unknown>>) {
        const hid = (o.hubId || '') as string;
        if (hid) objByHub.set(hid, o);
      }
      const result: Array<Record<string, unknown>> = [];
      await mapLimit(hubs, 4, async (h: AjaxHubSummary): Promise<void> => {
        try {
          const [devs, rooms, groups] = await Promise.all([
            this.listDevices(h.hubId).catch(() => [] as unknown[]),
            this.listRooms(h.hubId).catch(() => [] as unknown[]),
            this.listGroups(h.hubId).catch(() => [] as unknown[]),
          ]);
          const roomMap = new Map<string, string>();
          for (const r of rooms as Array<Record<string, unknown>>) roomMap.set(String(r.id), (r.roomName || '') as string);
          const groupMap = new Map<string, string>();
          for (const g of groups as Array<Record<string, unknown>>) groupMap.set(String(g.id), (g.groupName || '') as string);
          const obj = objByHub.get(h.hubId);
          for (const d of devs as Array<Record<string, unknown>>) {
            const malf = Array.isArray(d.malfunctions) ? (d.malfunctions as unknown[]).length : 0;
            const tampered = d.tampered === true;
            result.push({
              deviceId: d.id || d.deviceId,
              deviceName: d.deviceName || d.name,
              deviceType: d.deviceType,
              online: d.online ?? null,
              malfunctions: malf,
              tampered,
              hasAlerts: malf > 0 || tampered,
              roomId: d.roomId,
              roomName: d.roomId ? roomMap.get(String(d.roomId)) : null,
              groupId: d.groupId,
              groupName: d.groupId ? groupMap.get(String(d.groupId)) : null,
              hubId: h.hubId,
              hubName: h.name,
              hubSubtype: h.hubSubtype,
              objectName: obj?.name || null,
              objectId: obj?.id || null,
              objectRegistrationNumber: obj?.registrationNumber || null,
            });
          }
        } catch (_e) { /* skip hubs that fail */ }
      });
      return result;
    }, 60);
  }

  // ===== Hub logs (eventos del hub) =====
  async getHubLogs(hubId: string, pageSize = 50, pageIndex = 0): Promise<unknown[]> {
    return cached(`hub:${hubId}:logs:${pageSize}:${pageIndex}`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/logs', {
        params: { pageSize, pageIndex },
      });
      return Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
    }, 20);
  }

  // ===== Rooms y Grupos del hub =====
  async listRooms(hubId: string): Promise<unknown[]> {
    return cached(`hub:${hubId}:rooms`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/rooms');
      return Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
    });
  }
  async listGroups(hubId: string): Promise<unknown[]> {
    return cached(`hub:${hubId}:groups`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/groups');
      return Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
    });
  }

  // ===== Objects (facilidades) =====
  async listObjects(pageSize = 200, pageIndex = 0): Promise<unknown[]> {
    if (!hasCompanyAuth) return [];
    return cached(`company:${config.AJAX_COMPANY_ID}:objects:${pageSize}:${pageIndex}`, async () => {
      const res = await ajaxApiClient.get(`/api/company/${config.AJAX_COMPANY_ID}/objects/all`, {
        params: { pageSize, pageIndex },
      });
      return (res.data?.data ?? res.data ?? []) as unknown[];
    });
  }
  async getObject(oid: string): Promise<unknown> {
    return cached(`object:${oid}`, async () => {
      const [main, notes, responsible] = await Promise.all([
        ajaxApiClient.get(`/api/company/${config.AJAX_COMPANY_ID}/objects/${oid}`).then((r) => r.data).catch(() => null),
        ajaxApiClient.get(`/api/company/${config.AJAX_COMPANY_ID}/objects/${oid}/notes`).then((r) => r.data).catch(() => []),
        ajaxApiClient.get(`/api/company/${config.AJAX_COMPANY_ID}/objects/${oid}/responsible`).then((r) => r.data).catch(() => []),
      ]);
      return { ...((main as object) || {}), notes, responsible };
    });
  }

  // ===== Comandos sobre el hub (armado / panico / mute) =====
  async armHub(hubId: string, armed: boolean): Promise<unknown> {
    const body = { state: armed ? 'ARMED' : 'DISARMED' };
    const res = await ajaxApiClient.put(this.hubBasePath(hubId) + '/commands/arming', body);
    await this.invalidateHub(hubId);
    return res.data;
  }
  async panicHub(hubId: string): Promise<unknown> {
    const res = await ajaxApiClient.put(this.hubBasePath(hubId) + '/commands/panic', {});
    return res.data;
  }
  async muteHub(hubId: string): Promise<unknown> {
    const res = await ajaxApiClient.put(this.hubBasePath(hubId) + '/commands/muteSoundIndication', {});
    return res.data;
  }

  /**
   * Solicita foto on-demand a un dispositivo MotionCam.
   * Las fotos NO llegan en la respuesta HTTP — Ajax las publica de forma asincrona
   * en la cola SQS con eventTag PhotoOnDemand / PHOTO_BY_SCENARIO,
   * en additionalData.PHOTOS_RESOURCE_DESCRIPTION.orderedResourceLinks[].url.
   *
   * deviceType: ej. 'MotionCam', 'MotionCamOutdoor', 'MotionCamPhOD' (Jeweller variant).
   * Si no se pasa, intentamos detectarlo desde el device.
   */
  async requestDevicePhoto(hubId: string, deviceId: string, deviceType?: string): Promise<unknown> {
    let dtype = deviceType;
    if (!dtype) {
      try {
        const dev = await ajaxApiClient.get(this.hubBasePath(hubId) + `/devices/${deviceId}`);
        const data = dev.data as Record<string, unknown> | undefined;
        dtype = (data && typeof data.deviceType === 'string') ? data.deviceType : undefined;
      } catch { /* ignore */ }
    }
    if (!dtype || !/motion.?cam/i.test(dtype)) {
      const err: Error & { status?: number; userMessage?: string } = new Error(`device_not_motioncam`);
      err.status = 400;
      err.userMessage = `El sensor no es un MotionCam (deviceType=${dtype || 'desconocido'}). Solo los detectores con camara pueden tomar fotos on-demand.`;
      throw err;
    }
    const url = this.hubBasePath(hubId) + `/devices/${deviceId}/command`;
    const body = { command: 'MAKE_PHOTO', deviceType: dtype };
    try {
      const res = await ajaxApiClient.post(url, body);
      return res.data;
    } catch (axErr) {
      const ax = axErr as { response?: { status?: number; data?: { message?: string } }; message?: string };
      const status = ax.response?.status;
      const upstreamMsg = ax.response?.data?.message || ax.message || '';
      const err: Error & { status?: number; userMessage?: string } = new Error(`ajax_command_failed_${status || 'unknown'}`);
      err.status = status === 403 ? 403 : (status === 404 ? 404 : 502);
      if (status === 403) {
        err.userMessage = 'Sin permiso para enviar comandos a este hub. El binding tiene status NO_MONITORING (solo recepcion de eventos). Pedir a Ajax que active el binding completo.';
      } else if (status === 404) {
        err.userMessage = 'Hub o dispositivo no encontrado en la company.';
      } else {
        err.userMessage = `Ajax rechazo el comando (status ${status}): ${upstreamMsg.slice(0, 200)}`;
      }
      throw err;
    }
  }

  // ===== Monitoring (CMS que cubren el hub) =====
  async getHubMonitoring(hubId: string): Promise<unknown> {
    return cached(`hub:${hubId}:monitoring`, async () => {
      const res = await ajaxApiClient.get(this.hubBasePath(hubId) + '/monitoring');
      return res.data;
    });
  }

  // Invalidar caches dependientes (ej. cuando un comando cambia el estado del hub)
  private async invalidateHub(hubId: string): Promise<void> {
    try {
      const keys = [
        `${CACHE_PREFIX}hub:${hubId}`,
        `${CACHE_PREFIX}hub:${hubId}:devices`,
        `${CACHE_PREFIX}company:${config.AJAX_COMPANY_ID}:hubs:enriched`,
      ];
      await Promise.all(keys.map((k) => redis.del(k)));
    } catch { /* ignore */ }
  }
}

function toHubSummary(h: Record<string, unknown>): AjaxHubSummary {
  const fw = h.firmware as { version?: string } | string | undefined;
  const firmware = typeof fw === 'object' && fw !== null ? fw.version : (fw as string | undefined);
  let online: boolean | undefined;
  if (typeof h.online === 'boolean') online = h.online;
  else if (typeof h.isOnline === 'boolean') online = h.isOnline;
  else if (typeof h.connected === 'boolean') online = h.connected;
  else if (typeof h.state === 'string' && h.state) online = true;
  const eth = (h.ethernet as { enabled?: boolean; ip?: string } | null | undefined) || {};
  const gsm = (h.gsm as { gprsEnabled?: boolean; signalLevel?: number | null } | null | undefined) || {};
  const wifi = (h.wifi as { enabled?: boolean } | null | undefined) || {};
  const noise = (h.noiseLevel as { high?: boolean } | null | undefined) || {};
  const battery = (h.battery as { chargeLevelPercentage?: number | null } | null | undefined) || {};
  return {
    hubId: (h.id ?? h.hubId ?? h.deviceId ?? '') as string,
    name: (h.name ?? h.alias) as string | undefined,
    online,
    lastSeen: (h.lastSeen ?? h.lastSeenAt ?? h.lastConnection) as string | undefined,
    firmware,
    state: typeof h.state === 'string' ? (h.state as string) : undefined,
    tampered: (h.tampered as boolean | null | undefined) ?? null,
    hubSubtype: (typeof h.hubSubtype === 'string'
      ? (h.hubSubtype as string)
      : undefined),
    ethernetEnabled: eth.enabled ?? undefined,
    ethernetIp: eth.ip || undefined,
    gsmEnabled: gsm.gprsEnabled ?? undefined,
    gsmSignal: gsm.signalLevel ?? null,
    wifiEnabled: wifi.enabled ?? undefined,
    noiseHigh: noise.high ?? undefined,
    batteryPct: battery.chargeLevelPercentage ?? null,
    externallyPowered: (h.externallyPowered as boolean | null | undefined) ?? null,
    devicesCount: undefined,
    raw: h,
  };
}

export const ajaxCloudService = new AjaxCloudService();
