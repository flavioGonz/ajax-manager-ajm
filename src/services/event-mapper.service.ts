/**
 * Mapper de codigos de eventos de Ajax -> descripciones amigables.
 *
 * Ajax usa tres formatos al reportar eventos segun el canal:
 *  - CID (Contact ID, SIA DC-05) - codigos numericos de 3 digitos.
 *  - SIA (SIA DC-09) - codigos alfanumericos (BA, FA, etc).
 *  - AJAX (Enterprise SQS) - eventTag semantico ("MotionDetected", "Arm", ...)
 *    + eventCode propio (M_XXX_YY) + transition (TRIGGERED/RECOVERED).
 */

export type EventSeverity = 'ALARM' | 'WARNING' | 'INFO' | 'MAINTENANCE' | 'UNKNOWN';

export interface MappedEvent {
  code: string;
  protocol: 'CID' | 'SIA' | 'AJAX' | 'UNKNOWN';
  description: string;
  severity: EventSeverity;
}

// ============================================================
// Tabla eventTag Ajax (SQS) -> descripcion + severidad
// ============================================================
const AJAX_TAG_MAP: Record<string, { description: string; severity: EventSeverity }> = {
  PanicAlarm:              { description: 'Alarma de panico',               severity: 'ALARM' },
  FireAlarm:               { description: 'Alarma de incendio',             severity: 'ALARM' },
  GasAlarm:                { description: 'Alarma de gas',                  severity: 'ALARM' },
  LeakageDetected:         { description: 'Fuga de agua detectada',         severity: 'ALARM' },
  MotionDetected:          { description: 'Movimiento detectado',           severity: 'WARNING' },
  MotionDetectedLeft:      { description: 'Movimiento (lado izq.)',         severity: 'WARNING' },
  MotionDetectedRight:     { description: 'Movimiento (lado der.)',         severity: 'WARNING' },
  GlassBreakDetected:      { description: 'Rotura de vidrio',               severity: 'ALARM' },
  IntrusionAlarm:          { description: 'Intrusion',                     severity: 'ALARM' },
  HoldUpAlarm:             { description: 'Coaccion / atraco',             severity: 'ALARM' },
  OpeningDetected:         { description: 'Apertura detectada',            severity: 'WARNING' },
  ClosingDetected:         { description: 'Cierre detectado',              severity: 'INFO' },
  Arm:                     { description: 'Hub armado',                    severity: 'INFO' },
  Disarm:                  { description: 'Hub desarmado',                 severity: 'INFO' },
  ArmInNightMode:          { description: 'Armado modo noche',             severity: 'INFO' },
  DisarmNightMode:         { description: 'Sale modo noche',               severity: 'INFO' },
  PartialArm:              { description: 'Armado parcial',                severity: 'INFO' },
  Tampered:                { description: 'Tamper disparado',              severity: 'WARNING' },
  TamperRestored:          { description: 'Tamper restaurado',             severity: 'INFO' },
  Online:                  { description: 'Hub online',                    severity: 'INFO' },
  Offline:                 { description: 'Hub offline',                   severity: 'WARNING' },
  ConnectionLost:          { description: 'Conexion perdida',              severity: 'WARNING' },
  ConnectionRestored:      { description: 'Conexion restaurada',           severity: 'INFO' },
  ServerConnectionLoss:    { description: 'Sin conexion a Ajax Cloud',     severity: 'WARNING' },
  ServerConnectionOk:      { description: 'Ajax Cloud OK',                 severity: 'INFO' },
  DeviceCommunicationLoss: { description: 'Sensor sin comunicacion',       severity: 'WARNING' },
  DeviceCommunicationOk:   { description: 'Sensor comunicacion OK',        severity: 'INFO' },
  RFJamming:               { description: 'Jamming RF detectado',          severity: 'WARNING' },
  EthernetConnected:       { description: 'Ethernet conectado',            severity: 'INFO' },
  EthernetDisconnected:    { description: 'Ethernet desconectado',         severity: 'WARNING' },
  PowerLoss:               { description: 'Corte de luz',                  severity: 'WARNING' },
  PowerRestored:           { description: 'Luz restaurada',                severity: 'INFO' },
  ExternalPowerLoss:       { description: 'Sin alimentacion externa 220V', severity: 'WARNING' },
  ExternalPowerRestored:   { description: 'Alimentacion 220V restaurada',  severity: 'INFO' },
  BatteryLow:              { description: 'Bateria baja',                  severity: 'WARNING' },
  BatteryOk:               { description: 'Bateria OK',                    severity: 'INFO' },
  TurnOn:                  { description: 'Hub encendido',                 severity: 'INFO' },
  TurnOff:                 { description: 'Hub apagado',                   severity: 'WARNING' },
  Restart:                 { description: 'Hub reiniciado',                severity: 'INFO' },
  ObjectAdded:             { description: 'Dispositivo agregado',          severity: 'INFO' },
  ObjectRemoved:           { description: 'Dispositivo quitado',           severity: 'INFO' },
  Test:                    { description: 'Test',                          severity: 'MAINTENANCE' },
  FirmwareUpdated:         { description: 'Firmware actualizado',          severity: 'INFO' },
  ConfigChanged:           { description: 'Configuracion cambiada',        severity: 'INFO' },
  UserAdded:               { description: 'Usuario agregado',              severity: 'INFO' },
  UserRemoved:             { description: 'Usuario quitado',               severity: 'INFO' },
  UserAccessGranted:       { description: 'Acceso concedido',              severity: 'INFO' },
  UserAccessDenied:        { description: 'Acceso denegado',               severity: 'WARNING' },
  PhotoOnDemand:           { description: 'Foto on-demand',                severity: 'INFO' },
  PhotoByScenario:         { description: 'Foto por escenario',            severity: 'INFO' },
  VisualAlarmVerification: { description: 'Verificacion visual de alarma', severity: 'ALARM' },
  // Eventos a nivel Space (grupo de hubs / sitio fisico)
  SpaceArmed:              { description: 'Sitio armado',                   severity: 'INFO' },
  SpaceDisarmed:           { description: 'Sitio desarmado',                severity: 'INFO' },
  SpaceArmedNightMode:     { description: 'Sitio armado modo noche',        severity: 'INFO' },
  SpacePartiallyArmed:     { description: 'Sitio parcialmente armado',      severity: 'INFO' },
  // Valvulas inteligentes / WaterStop
  ValveOpenedByUser:       { description: 'Valvula abierta por usuario',    severity: 'INFO' },
  ValveClosedByUser:       { description: 'Valvula cerrada por usuario',    severity: 'INFO' },
  ValveOpenedAutomatically:{ description: 'Valvula abierta auto',           severity: 'INFO' },
  ValveClosedAutomatically:{ description: 'Valvula cerrada auto',           severity: 'INFO' },
  // SmartHome actuators
  RelayOn:                 { description: 'Rele activado',                  severity: 'INFO' },
  RelayOff:                { description: 'Rele desactivado',               severity: 'INFO' },
  RelayPulseDelivered:     { description: 'Pulso de rele entregado',        severity: 'INFO' },
  // Mas eventos comunes que pueden aparecer
  LowSignal:               { description: 'Senal baja',                     severity: 'WARNING' },
  SignalRestored:          { description: 'Senal restaurada',               severity: 'INFO' },
  HubLowBattery:           { description: 'Hub bateria baja',               severity: 'WARNING' },
  HubBatteryOk:            { description: 'Hub bateria OK',                 severity: 'INFO' },
  AlarmCancelled:          { description: 'Alarma cancelada',               severity: 'INFO' },
  AlarmAcknowledged:       { description: 'Alarma reconocida',              severity: 'INFO' },
  // Smart home
  LightTurnedOn:           { description: 'Luz encendida',                  severity: 'INFO' },
  LightTurnedOff:          { description: 'Luz apagada',                    severity: 'INFO' },
  TemperatureHigh:         { description: 'Temperatura alta',               severity: 'WARNING' },
  TemperatureLow:          { description: 'Temperatura baja',               severity: 'WARNING' },
  TemperatureNormal:       { description: 'Temperatura normal',             severity: 'INFO' },
  HumidityHigh:            { description: 'Humedad alta',                   severity: 'WARNING' },
  HumidityLow:             { description: 'Humedad baja',                   severity: 'WARNING' },
};

function humanizeCamel(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

const CID_MAP: Record<string, { description: string; severity: EventSeverity }> = {
  '100': { description: 'Alarma medica',                 severity: 'ALARM' },
  '101': { description: 'Pulsador de panico medico',     severity: 'ALARM' },
  '110': { description: 'Alarma de incendio',            severity: 'ALARM' },
  '111': { description: 'Humo detectado',                severity: 'ALARM' },
  '113': { description: 'Inundacion',                    severity: 'ALARM' },
  '114': { description: 'Calor (alta temperatura)',      severity: 'ALARM' },
  '120': { description: 'Panico (atraco)',               severity: 'ALARM' },
  '121': { description: 'Coaccion (codigo bajo amenaza)',severity: 'ALARM' },
  '122': { description: 'Pulsador silencioso',           severity: 'ALARM' },
  '130': { description: 'Intrusion',                     severity: 'ALARM' },
  '131': { description: 'Intrusion perimetral',          severity: 'ALARM' },
  '132': { description: 'Intrusion interior',            severity: 'ALARM' },
  '133': { description: 'Intrusion 24h',                 severity: 'ALARM' },
  '134': { description: 'Apertura/cierre de zona',       severity: 'ALARM' },
  '137': { description: 'Tamper de zona',                severity: 'WARNING' },
  '138': { description: 'Pre-alarma de intrusion',       severity: 'WARNING' },
  '144': { description: 'Tamper de sensor',              severity: 'WARNING' },
  '145': { description: 'Tamper expansor',               severity: 'WARNING' },
  '301': { description: 'Perdida de alimentacion AC',    severity: 'WARNING' },
  '302': { description: 'Bateria baja del panel',        severity: 'WARNING' },
  '305': { description: 'Reset del sistema',             severity: 'INFO' },
  '306': { description: 'Cambio de programacion',        severity: 'INFO' },
  '309': { description: 'Test de bateria fallido',       severity: 'WARNING' },
  '351': { description: 'Falla de linea telefonica',     severity: 'WARNING' },
  '353': { description: 'Falla radio (long range)',      severity: 'WARNING' },
  '354': { description: 'Falla de comunicacion con CRA', severity: 'WARNING' },
  '356': { description: 'Perdida de polling',            severity: 'WARNING' },
  '381': { description: 'Perdida de supervision RF',     severity: 'WARNING' },
  '383': { description: 'Tamper sensor RF',              severity: 'WARNING' },
  '384': { description: 'Bateria baja sensor RF',        severity: 'WARNING' },
  '401': { description: 'Armado/desarmado por usuario',  severity: 'INFO' },
  '402': { description: 'Armado/desarmado de grupo',     severity: 'INFO' },
  '403': { description: 'Armado/desarmado automatico',   severity: 'INFO' },
  '406': { description: 'Cancelacion de alarma',         severity: 'INFO' },
  '407': { description: 'Armado/desarmado remoto',       severity: 'INFO' },
  '570': { description: 'Zona bypassed',                 severity: 'INFO' },
  '573': { description: 'Bypass 24h',                    severity: 'WARNING' },
  '601': { description: 'Test manual',                   severity: 'MAINTENANCE' },
  '602': { description: 'Test periodico',                severity: 'MAINTENANCE' },
  '607': { description: 'Modo walk-test',                severity: 'MAINTENANCE' },
};

const SIA_MAP: Record<string, { description: string; severity: EventSeverity }> = {
  BA: { description: 'Burglary Alarm - Intrusion',     severity: 'ALARM' },
  BR: { description: 'Burglary Restore',               severity: 'INFO' },
  BB: { description: 'Burglary Bypass',                severity: 'WARNING' },
  BU: { description: 'Burglary Unbypass',              severity: 'INFO' },
  FA: { description: 'Fire Alarm - Incendio',          severity: 'ALARM' },
  FR: { description: 'Fire Restore',                   severity: 'INFO' },
  HA: { description: 'Holdup Alarm - Atraco',          severity: 'ALARM' },
  HR: { description: 'Holdup Restore',                 severity: 'INFO' },
  MA: { description: 'Medical Alarm',                  severity: 'ALARM' },
  PA: { description: 'Panic Alarm',                    severity: 'ALARM' },
  PR: { description: 'Panic Restore',                  severity: 'INFO' },
  TA: { description: 'Tamper Alarm',                   severity: 'WARNING' },
  TR: { description: 'Tamper Restore',                 severity: 'INFO' },
  WA: { description: 'Water Alarm - Inundacion',       severity: 'ALARM' },
  WR: { description: 'Water Restore',                  severity: 'INFO' },
  GA: { description: 'Gas Alarm',                      severity: 'ALARM' },
  GR: { description: 'Gas Restore',                    severity: 'INFO' },
  AT: { description: 'AC Trouble - Perdida de AC',     severity: 'WARNING' },
  AR: { description: 'AC Restore',                     severity: 'INFO' },
  YT: { description: 'Battery Trouble - Bateria baja', severity: 'WARNING' },
  YR: { description: 'Battery Restore',                severity: 'INFO' },
  YS: { description: 'Communication Trouble',          severity: 'WARNING' },
  YK: { description: 'Communication Restore',          severity: 'INFO' },
  OP: { description: 'Opening - Desarmado',            severity: 'INFO' },
  CL: { description: 'Closing - Armado',               severity: 'INFO' },
  RP: { description: 'Automatic Test',                 severity: 'MAINTENANCE' },
  RX: { description: 'Manual Test',                    severity: 'MAINTENANCE' },
};

export function mapEventCode(code: string | null | undefined, event?: Record<string, unknown>): MappedEvent {
  const tag = typeof event?.eventTag === 'string' ? (event.eventTag as string) : undefined;
  const transition = typeof event?.transition === 'string' ? (event.transition as string).toUpperCase() : undefined;
  const ajaxCode = code || (typeof event?.eventCode === 'string' ? (event.eventCode as string) : '');

  if (tag) {
    const entry = AJAX_TAG_MAP[tag];
    let severity: EventSeverity = entry?.severity ?? 'UNKNOWN';
    if (transition === 'RECOVERED' && severity !== 'INFO' && severity !== 'MAINTENANCE') severity = 'INFO';
    if (transition === 'TRIGGERED' && severity === 'UNKNOWN') severity = 'WARNING';
    const transitionLabel = transition === 'RECOVERED' ? ' (restaurado)' : transition === 'TRIGGERED' ? ' (disparado)' : '';
    return {
      code: ajaxCode || tag,
      protocol: 'AJAX',
      description: (entry?.description ?? humanizeCamel(tag)) + transitionLabel,
      severity,
    };
  }

  if (!code) {
    return { code: '', protocol: 'UNKNOWN', description: 'Sin codigo', severity: 'UNKNOWN' };
  }

  const normalized = code.trim().toUpperCase();

  if (/^\d{3}$/.test(normalized)) {
    const entry = CID_MAP[normalized];
    return {
      code: normalized,
      protocol: 'CID',
      description: entry?.description ?? `Codigo CID ${normalized} (no mapeado)`,
      severity: entry?.severity ?? 'UNKNOWN',
    };
  }

  if (/^[A-Z]{2}$/.test(normalized)) {
    const entry = SIA_MAP[normalized];
    return {
      code: normalized,
      protocol: 'SIA',
      description: entry?.description ?? `Codigo SIA ${normalized} (no mapeado)`,
      severity: entry?.severity ?? 'UNKNOWN',
    };
  }

  if (/^M_[A-Z0-9]+_[A-Z0-9]+$/i.test(normalized)) {
    return {
      code: normalized,
      protocol: 'AJAX',
      description: `Evento Ajax ${normalized}`,
      severity: 'UNKNOWN',
    };
  }

  return {
    code: normalized,
    protocol: 'UNKNOWN',
    description: `Codigo no reconocido: ${normalized}`,
    severity: 'UNKNOWN',
  };
}

export function extractEventCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const ev = (p.event && typeof p.event === 'object' ? (p.event as Record<string, unknown>) : null);

  const candidates: Array<unknown> = [
    ev?.eventCode,
    p.eventCode,
    p.code,
    p.cid,
    p.sia,
    p.contactId,
    ev?.code,
    ev?.cid,
    ev?.sia,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (typeof c === 'number') return String(c).padStart(3, '0');
  }
  return null;
}
