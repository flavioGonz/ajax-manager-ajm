/**
 * Canal SCADA_OPC: AJM se conecta al servidor OPC UA del SCADA y escribe
 * los nodos correspondientes cuando llega un evento.
 *
 * Pool de sesiones: una conexion OPC UA viva por cada WebhookSubscription
 * activa de tipo SCADA_OPC. Reconnect automatico si se cae.
 *
 * Configuracion en sub.config:
 *   endpointUrl     (string, requerido)  ej. opc.tcp://192.168.99.40:62541
 *   nodeIdTemplate  (string)              default ns=2;s=AJM/{hubId}/{var}
 *   username        (string, opcional)
 *   password        (string, opcional)
 *
 * Variables del template: {hubId}, {var} (lastCode|lastSeverity|lastDescription|lastTime),
 *   {eventCode}, {severity}
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AjaxEvent, WebhookSubscription } from '@prisma/client';
import { logger } from '../../utils/logger';
import type { DeliveryResult } from './index';

interface OpcSubConfig {
  endpointUrl?: string;
  nodeIdTemplate?: string;
  username?: string;
  password?: string;
}

interface PooledSession {
  client: any;
  session: any;
  endpointUrl: string;
  connectedAt: Date;
}

const sessions = new Map<string, PooledSession>();
const reconnecting = new Set<string>();

async function ensureSession(sub: WebhookSubscription): Promise<PooledSession | null> {
  const cfg = (sub.config || {}) as OpcSubConfig;
  if (!cfg.endpointUrl) return null;

  // Si la URL cambio, descartamos la session vieja
  const cached = sessions.get(sub.id);
  if (cached && cached.endpointUrl !== cfg.endpointUrl) {
    await cleanupSession(sub.id);
  }
  if (sessions.has(sub.id)) return sessions.get(sub.id)!;
  if (reconnecting.has(sub.id)) return null;

  reconnecting.add(sub.id);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const opcua = require('node-opcua');
    const { OPCUAClient, MessageSecurityMode, SecurityPolicy, UserTokenType } = opcua;
    const client = OPCUAClient.create({
      applicationName: 'AjaxManagerAJM-Channel',
      endpointMustExist: false,
      connectionStrategy: { initialDelay: 1000, maxRetry: 0 },
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
    });
    client.on('connection_lost', () => {
      logger.warn({ subId: sub.id }, 'OPC channel: conexion perdida');
      cleanupSession(sub.id).catch(() => {});
    });
    await client.connect(cfg.endpointUrl);
    const userIdentity = (cfg.username && cfg.password)
      ? { type: UserTokenType.UserName, userName: cfg.username, password: cfg.password }
      : { type: UserTokenType.Anonymous };
    const session = await client.createSession(userIdentity);
    const pooled: PooledSession = { client, session, endpointUrl: cfg.endpointUrl, connectedAt: new Date() };
    sessions.set(sub.id, pooled);
    logger.info({ subId: sub.id, endpoint: cfg.endpointUrl }, 'OPC channel: session establecida');
    return pooled;
  } catch (err) {
    logger.error({ subId: sub.id, err: (err as Error).message }, 'OPC channel: fallo al conectar');
    return null;
  } finally {
    reconnecting.delete(sub.id);
  }
}

async function cleanupSession(subId: string): Promise<void> {
  const p = sessions.get(subId);
  if (!p) return;
  try { await p.session.close(); } catch (_e) { /* ignore */ }
  try { await p.client.disconnect(); } catch (_e) { /* ignore */ }
  sessions.delete(subId);
}

export async function dispatchScadaOpc(event: AjaxEvent, sub: WebhookSubscription): Promise<DeliveryResult> {
  const cfg = (sub.config || {}) as OpcSubConfig;
  if (!cfg.endpointUrl) return { ok: false, errorMessage: 'endpointUrl requerida en config' };
  if (!event.hubId) return { ok: false, errorMessage: 'evento sin hubId, no se puede mapear' };

  const pooled = await ensureSession(sub);
  if (!pooled) return { ok: false, errorMessage: 'sin sesion OPC activa al SCADA' };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DataType, StatusCodes, AttributeIds } = require('node-opcua');
  const tpl = cfg.nodeIdTemplate || 'ns=2;s=AJM/{hubId}/{var}';
  const renderNodeId = (varName: string) =>
    tpl.replace('{hubId}', event.hubId || '')
       .replace('{var}', varName)
       .replace('{eventCode}', event.eventCode || '')
       .replace('{severity}', event.severity || '');

  const writes = [
    { name: 'lastCode',        value: event.eventCode || '',       dataType: DataType.String },
    { name: 'lastSeverity',    value: event.severity || '',        dataType: DataType.String },
    { name: 'lastDescription', value: event.description || '',     dataType: DataType.String },
    { name: 'lastTime',        value: event.occurredAt || new Date(), dataType: DataType.DateTime },
  ];

  let okCount = 0;
  let firstError: string | undefined;
  for (const w of writes) {
    try {
      const result = await pooled.session.write({
        nodeId: renderNodeId(w.name),
        attributeId: AttributeIds.Value,
        value: { value: { dataType: w.dataType, value: w.value } },
      });
      const sc = result?.value ?? result;
      if (sc === StatusCodes.Good || sc?.name === 'Good') okCount++;
      else if (!firstError) firstError = `write ${w.name}: ${sc?.name || sc}`;
    } catch (err) {
      if (!firstError) firstError = `${w.name}: ${(err as Error).message}`;
      // Si la session se cayó, limpiar para reconectar al proximo evento
      await cleanupSession(sub.id);
      return { ok: false, errorMessage: firstError };
    }
  }
  if (okCount === writes.length) return { ok: true };
  return { ok: false, errorMessage: firstError || 'algunos writes fallaron' };
}

export async function shutdownAllScadaOpc(): Promise<void> {
  const ids = [...sessions.keys()];
  for (const id of ids) await cleanupSession(id);
}

export function getScadaOpcStatus() {
  return {
    activeSessions: sessions.size,
    sessions: [...sessions.entries()].map(([subId, p]) => ({
      subscriptionId: subId,
      endpointUrl: p.endpointUrl,
      connectedAt: p.connectedAt.toISOString(),
    })),
  };
}
