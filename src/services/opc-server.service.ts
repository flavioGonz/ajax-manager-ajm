/**
 * OPC UA Server para integracion con SCADAs.
 * Expone hubs Ajax como nodos OPC UA.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from '../utils/logger';

interface OpcServerConfig {
  enabled: boolean;
  port: number;
  resourcePath: string;
  applicationUri: string;
  serverName: string;
  username?: string;
  password?: string;
}

interface PublishedEvent {
  hubId?: string | null;
  eventCode?: string | null;
  protocol?: string | null;
  severity?: string | null;
  description?: string | null;
  occurredAt?: Date | null;
}

interface HubVarSet {
  online: any;
  lastCode: any;
  lastProto: any;
  lastSeverity: any;
  lastDescription: any;
  lastTime: any;
  alarmCount: any;
}

class OpcServerService {
  private server: any = null;
  private namespace: any = null;
  private hubsFolder: any = null;
  private hubVars = new Map<string, HubVarSet>();
  private alarmCounts = new Map<string, number>();
  private started = false;
  private startedAt: Date | null = null;
  private connectedSessions = 0;
  private lastEventAt: Date | null = null;
  private totalPublished = 0;
  private cfg: OpcServerConfig | null = null;

  async start(cfg: OpcServerConfig): Promise<void> {
    if (!cfg.enabled) {
      logger.info('OPC UA Server: deshabilitado (OPC_ENABLED=false)');
      return;
    }
    if (this.started) {
      logger.warn('OPC UA Server ya esta corriendo');
      return;
    }
    this.cfg = cfg;
    let opcua: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      opcua = require('node-opcua');
    } catch {
      logger.warn('node-opcua no instalado - el OPC server no arranca');
      return;
    }

    const { OPCUAServer, MessageSecurityMode, SecurityPolicy } = opcua;

    const server = new OPCUAServer({
      port: cfg.port,
      resourcePath: cfg.resourcePath,
      buildInfo: {
        productName: 'AjaxManagerAJM',
        manufacturerName: 'IES (Ingenieria en Seguridad)',
        productUri: cfg.applicationUri,
        softwareVersion: '0.6.0',
      },
      serverInfo: {
        applicationUri: cfg.applicationUri,
        productUri: cfg.applicationUri,
        applicationName: { text: cfg.serverName, locale: 'es-UY' },
      },
      securityPolicies: [SecurityPolicy.None],
      securityModes: [MessageSecurityMode.None],
      allowAnonymous: true,
      userManager: cfg.username && cfg.password ? {
        isValidUser: (u: string, p: string) => u === cfg.username && p === cfg.password,
      } : undefined,
    });

    await server.initialize();
    const addressSpace = server.engine.addressSpace;
    const ns = addressSpace.getOwnNamespace();
    this.namespace = ns;

    const ajmObj = ns.addObject({
      organizedBy: addressSpace.rootFolder.objects,
      browseName: 'AjaxManager',
    });

    // Stats variables (lazy via get())
    const statsObj = ns.addObject({ organizedBy: ajmObj, browseName: 'Stats' });
    const { Variant, DataType } = opcua;
    ns.addVariable({
      organizedBy: statsObj,
      browseName: 'TotalEventsPublished',
      dataType: 'UInt64',
      value: { get: () => new Variant({ dataType: DataType.UInt64, value: BigInt(this.totalPublished) }) },
    });
    ns.addVariable({
      organizedBy: statsObj,
      browseName: 'LastEventReceivedAt',
      dataType: 'DateTime',
      value: { get: () => new Variant({ dataType: DataType.DateTime, value: this.lastEventAt || new Date(0) }) },
    });
    ns.addVariable({
      organizedBy: statsObj,
      browseName: 'ConnectedSessions',
      dataType: 'UInt32',
      value: { get: () => new Variant({ dataType: DataType.UInt32, value: this.connectedSessions }) },
    });

    this.hubsFolder = ns.addObject({ organizedBy: ajmObj, browseName: 'Hubs' });

    server.on('newChannel', () => { this.connectedSessions = server.currentSessionCount; });
    server.on('closeChannel', () => { this.connectedSessions = server.currentSessionCount; });
    server.on('create_session', () => { this.connectedSessions = server.currentSessionCount; });
    server.on('session_closed', () => { this.connectedSessions = server.currentSessionCount; });

    await server.start();
    this.server = server;
    this.started = true;
    this.startedAt = new Date();
    const ep = server.endpoints[0]?.endpointDescriptions()[0]?.endpointUrl;
    logger.info({ port: cfg.port, endpoint: ep }, 'OPC UA Server arrancado');
  }

  async stop(): Promise<void> {
    if (!this.started || !this.server) return;
    try { await this.server.shutdown(1000); } catch (_e) { /* ignore */ }
    this.started = false;
    this.server = null;
    this.startedAt = null;
    this.hubVars.clear();
    logger.info('OPC UA Server detenido');
  }

  private getOrCreateHubNode(hubId: string): HubVarSet | null {
    if (!this.started || !this.namespace) return null;
    const cached = this.hubVars.get(hubId);
    if (cached) return cached;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const opcua = require('node-opcua');
    const { Variant, DataType } = opcua;
    const ns = this.namespace;

    const hubObj = ns.addObject({ organizedBy: this.hubsFolder, browseName: hubId });

    const mkVar = (name: string, dt: string, defaultVal: any) => {
      let cur = defaultVal;
      const v = ns.addVariable({
        organizedBy: hubObj,
        browseName: name,
        dataType: dt,
        value: { get: () => new Variant({ dataType: (DataType as any)[dt], value: cur }) },
      });
      v.setValueFromSource = (val: any) => { cur = val; };
      return v;
    };

    const node: HubVarSet = {
      online: mkVar('OnlineStatus', 'Boolean', true),
      lastCode: mkVar('LastEventCode', 'String', ''),
      lastProto: mkVar('LastEventProtocol', 'String', ''),
      lastSeverity: mkVar('LastSeverity', 'String', ''),
      lastDescription: mkVar('LastDescription', 'String', ''),
      lastTime: mkVar('LastEventTime', 'DateTime', new Date(0)),
      alarmCount: mkVar('ActiveAlarmCount', 'UInt32', 0),
    };
    this.hubVars.set(hubId, node);
    return node;
  }

  publishEvent(event: PublishedEvent): void {
    if (!this.started || !event.hubId) return;
    const node = this.getOrCreateHubNode(event.hubId);
    if (!node) return;
    node.lastCode.setValueFromSource(event.eventCode || '');
    node.lastProto.setValueFromSource(event.protocol || '');
    node.lastSeverity.setValueFromSource(event.severity || '');
    node.lastDescription.setValueFromSource(event.description || '');
    node.lastTime.setValueFromSource(event.occurredAt || new Date());
    if (event.severity === 'ALARM') {
      const cur = (this.alarmCounts.get(event.hubId) || 0) + 1;
      this.alarmCounts.set(event.hubId, cur);
      node.alarmCount.setValueFromSource(cur);
    }
    this.lastEventAt = new Date();
    this.totalPublished++;
  }

  acknowledgeAlarms(hubId: string): void {
    if (!this.started) return;
    const node = this.getOrCreateHubNode(hubId);
    if (!node) return;
    this.alarmCounts.set(hubId, 0);
    node.alarmCount.setValueFromSource(0);
  }

  getStatus() {
    return {
      enabled: this.cfg?.enabled ?? false,
      running: this.started,
      port: this.cfg?.port,
      resourcePath: this.cfg?.resourcePath,
      endpoint: this.started ? `opc.tcp://0.0.0.0:${this.cfg?.port}${this.cfg?.resourcePath}` : null,
      startedAt: this.startedAt?.toISOString() ?? null,
      connectedSessions: this.connectedSessions,
      hubsTracked: this.hubVars.size,
      totalPublished: this.totalPublished,
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
    };
  }
}

export const opcServerService = new OpcServerService();
