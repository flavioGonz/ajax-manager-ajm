import type { AjaxEvent, WebhookSubscription } from '@prisma/client';
import type { DeliveryResult } from './index';

// ============================================================
// Helpers (copia compacta de telegram.channel para no acoplar)
// ============================================================
function snakeToPascal(s: string): string {
  if (!s) return '';
  if (!/_/.test(s)) return s;
  return s.toLowerCase().split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

const MODEL_LABEL: Record<string, string> = {
  MotionProtect: 'Detector de movimiento',
  MotionProtectPlus: 'Detector de mov. con vidrios',
  MotionProtectOutdoor: 'Detector de mov. exterior',
  MotionProtectCurtain: 'Cortina de movimiento',
  MotionCam: 'Detector con camara',
  MotionCamOutdoor: 'Detector con camara exterior',
  MotionCamPhOD: 'MotionCam Jeweller PhOD',
  DoorProtect: 'Detector de apertura',
  DoorProtectPlus: 'Detector de apertura Plus',
  GlassProtect: 'Detector de rotura de vidrio',
  CombiProtect: 'Detector combinado',
  FireProtect: 'Detector de humo',
  FireProtectPlus: 'Detector de humo + CO',
  LeaksProtect: 'Detector de fugas de agua',
  WaterStop: 'Llave de paso inteligente',
  WaterStopBase: 'Llave de paso (base)',
  SpaceControl: 'Llavero',
  Button: 'Boton de panico',
  KeyPad: 'Teclado',
  KeyPadPlus: 'Teclado Plus',
  KeyPadTouchScreen: 'Teclado tactil',
  HomeSiren: 'Sirena interior',
  StreetSiren: 'Sirena exterior',
  Relay: 'Rele',
  WallSwitch: 'Interruptor de pared',
  Socket: 'Toma inteligente',
  Hub: 'Hub', Hub2: 'Hub 2', Hub2Plus: 'Hub 2 Plus', HubPlus: 'Hub Plus',
  ReX: 'Repetidor', ReX2: 'Repetidor 2',
  vhfBridge: 'Puente VHF',
  Transmitter: 'Transmisor',
  MultiTransmitter: 'Multi-transmisor',
  AccessCode: 'Codigo de acceso',
};
function modelLabel(type: string): string {
  return MODEL_LABEL[type] || type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
}

function getPublicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'https://ajm.infratec.com.uy').replace(/\/$/, '');
}

interface ExtractedInfo {
  hubName?: string;
  sourceObjectName?: string;
  sourceObjectTypeRaw?: string;
  sourceObjectTypePascal?: string;
  sourceObjectTypeLabel?: string;
  spaceName?: string;
  objectName?: string;
  transition?: string;
}

function extractEventInfo(event: AjaxEvent): ExtractedInfo {
  const raw = (event.rawPayload || {}) as Record<string, unknown>;
  const ev = (raw.event && typeof raw.event === 'object' ? raw.event as Record<string, unknown> : raw);
  const rec = (raw.recipient && typeof raw.recipient === 'object' ? raw.recipient as Record<string, unknown> : null);
  const binding = rec && rec.bindingDetails && typeof rec.bindingDetails === 'object'
    ? rec.bindingDetails as Record<string, unknown> : null;
  const rawType = typeof ev.sourceObjectType === 'string' ? ev.sourceObjectType as string : '';
  const typePascal = snakeToPascal(rawType);
  return {
    hubName: typeof ev.hubName === 'string' ? ev.hubName as string : undefined,
    sourceObjectName: typeof ev.sourceObjectName === 'string' ? ev.sourceObjectName as string : undefined,
    sourceObjectTypeRaw: rawType || undefined,
    sourceObjectTypePascal: typePascal || undefined,
    sourceObjectTypeLabel: typePascal ? modelLabel(typePascal) : undefined,
    spaceName: typeof ev.spaceName === 'string' ? ev.spaceName as string : undefined,
    objectName: binding && typeof binding.objectName === 'string' ? binding.objectName as string : undefined,
    transition: typeof ev.transition === 'string' ? ev.transition as string : undefined,
  };
}

// ============================================================
// Severity palette (alineada con la app)
// ============================================================
interface SevPalette { lbl: string; emoji: string; bg: string; fg: string; bgSoft: string; }
const SEV_PALETTE: Record<string, SevPalette> = {
  ALARM:       { lbl: 'ALARMA',       emoji: '\u{1F6A8}', bg: '#dc2626', fg: '#ffffff', bgSoft: '#fef2f2' },
  WARNING:     { lbl: 'ADVERTENCIA',  emoji: '\u{26A0}',  bg: '#ea580c', fg: '#ffffff', bgSoft: '#fff7ed' },
  INFO:        { lbl: 'INFORMATIVO',  emoji: '\u{2139}',  bg: '#2563eb', fg: '#ffffff', bgSoft: '#eff6ff' },
  MAINTENANCE: { lbl: 'MANTENIMIENTO',emoji: '\u{1F527}', bg: '#7c3aed', fg: '#ffffff', bgSoft: '#f5f3ff' },
  UNKNOWN:     { lbl: 'EVENTO',       emoji: '\u{1F514}', bg: '#475569', fg: '#ffffff', bgSoft: '#f1f5f9' },
};

function transitionLabel(t?: string): string {
  if (!t) return '';
  if (t === 'TRIGGERED') return 'Disparado';
  if (t === 'RECOVERED') return 'Restaurado';
  return t;
}

// ============================================================
// HTML template
// ============================================================
function buildHtml(event: AjaxEvent, info: ExtractedInfo): string {
  const sev = (event.severity || 'INFO').toUpperCase();
  const pal = SEV_PALETTE[sev] || SEV_PALETTE.UNKNOWN;
  const base = getPublicBaseUrl();

  const clientName = info.objectName || info.spaceName || info.hubName || 'Sin asignar';
  const hubName = info.hubName || event.hubId || '-';
  const showHubId = !!(event.hubId && info.hubName && event.hubId !== info.hubName);
  const sensorName = info.sourceObjectName || (info.sourceObjectTypeLabel ? info.sourceObjectTypeLabel : '-');
  const sensorModel = info.sourceObjectTypeLabel || '';
  const showSensorModel = !!(info.sourceObjectName && info.sourceObjectTypeLabel);

  const occurredFmt = event.occurredAt
    ? new Date(event.occurredAt).toLocaleString('es-UY', { timeZone: 'America/Montevideo', hour12: false })
    : '-';
  const transitionLbl = transitionLabel(info.transition);

  const raw = (event.rawPayload || {}) as Record<string, unknown>;
  const localPhotosE = Array.isArray(raw.__localPhotos) ? raw.__localPhotos as Array<{ url: string }> : [];
  const realPhotoUrl = localPhotosE.length > 0 ? `${base}${localPhotosE[0].url}` : '';
  // Archivos /app/data/device-images/ estan en UPPER_SNAKE (HUB.png, MOTION_CAM.png)
  const photoUrl = realPhotoUrl || (info.sourceObjectTypeRaw
    ? `${base}/device-images/${encodeURIComponent(info.sourceObjectTypeRaw)}.png`
    : `${base}/device-images/HUB.png`);
  // Si es foto real (MotionCam), mostrarla grande arriba como un hero;
  // si es icono del modelo, va chico al lado del titulo (como esta hoy)
  const photoIsHero = !!realPhotoUrl;
  const eventUrl = `${base}/dashboard/#/events/${encodeURIComponent(event.id)}`;
  const description = escapeHtml(event.description || event.eventCode || 'Evento Ajax');
  const codeText = escapeHtml(`${event.protocol || ''} ${event.eventCode || '-'}`.trim());

  const row = (label: string, value: string, opts: { mono?: boolean; bold?: boolean } = {}): string => {
    const valueStyle = [
      'padding:10px 12px',
      'font-size:14px',
      'color:#1f2937',
      'border-bottom:1px solid #f1f5f9',
      opts.mono ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace' : '',
      opts.bold ? 'font-weight:600' : '',
    ].filter(Boolean).join(';');
    return `<tr>
      <td style="padding:10px 12px;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #f1f5f9;width:130px;vertical-align:top">${label}</td>
      <td style="${valueStyle}">${value}</td>
    </tr>`;
  };

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>${pal.lbl} - ${description}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <tr><td style="background:${pal.bg};padding:20px 28px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle">
            <div style="font-size:13px;color:${pal.fg};opacity:.85;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">${pal.emoji} ${pal.lbl}</div>
            <div style="font-size:22px;color:${pal.fg};font-weight:700;line-height:1.25">${description}</div>
          </td>
          <td align="right" style="vertical-align:middle">
            ${photoIsHero ? '' : (photoUrl ? `<img src="${photoUrl}" alt="${escapeHtml(sensorModel)}" width="64" height="64" style="border-radius:10px;background:#ffffff;padding:6px;border:2px solid rgba(255,255,255,.3)">` : '')}
          </td>
        </tr></table>
      </td></tr>
      ${photoIsHero ? `<tr><td style="padding:0;background:#0d1117">
        <img src="${photoUrl}" alt="Foto del MotionCam" style="display:block;width:100%;max-height:380px;object-fit:cover">
        ${localPhotosE.length > 1 ? `<div style="padding:6px 12px;background:#0d1117;color:#94a3b8;font-size:11px;text-align:center">+ ${localPhotosE.length - 1} foto(s) mas en el detalle del evento</div>` : ''}
      </td></tr>` : ''}
      <tr><td style="padding:0 28px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0">
          ${row('Cliente', escapeHtml(clientName), { bold: true })}
          ${row('Hub', escapeHtml(hubName) + (showHubId ? ` <span style="color:#94a3b8;font-size:12px">(${escapeHtml(event.hubId || '')})</span>` : ''))}
          ${row('Sensor', escapeHtml(sensorName) + (showSensorModel ? ` <span style="color:#94a3b8;font-size:12px">(${escapeHtml(sensorModel)})</span>` : ''))}
          ${row('Codigo', `<span style="display:inline-block;background:#f1f5f9;padding:3px 8px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#475569">${codeText}</span>`)}
          ${row('Severidad', `<span style="display:inline-block;background:${pal.bgSoft};color:${pal.bg};padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:.05em">${pal.lbl}</span>`)}
          ${row('Cuando', escapeHtml(occurredFmt) + ' <span style="color:#94a3b8;font-size:12px">(hora Uruguay)</span>')}
          ${transitionLbl ? row('Transicion', `<span style="color:${info.transition === 'TRIGGERED' ? '#dc2626' : '#16a34a'};font-weight:600">${escapeHtml(transitionLbl)}</span>`) : ''}
        </table>
      </td></tr>
      <tr><td align="center" style="padding:8px 28px 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#0f172a;border-radius:10px">
          <a href="${eventUrl}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:.02em">Abrir evento en AJM &rarr;</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:18px 28px;border-top:1px solid #e2e8f0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-size:11px;color:#64748b;line-height:1.5">
            <strong style="color:#1e293b">Ajax Manager &middot; IES</strong><br>
            Notificacion automatica del sistema de monitoreo Ajax Systems Enterprise.<br>
            ID evento: <span style="font-family:ui-monospace,monospace;color:#475569">${escapeHtml(event.id)}</span>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildText(event: AjaxEvent, info: ExtractedInfo): string {
  const sev = (event.severity || 'INFO').toUpperCase();
  const pal = SEV_PALETTE[sev] || SEV_PALETTE.UNKNOWN;
  const clientName = info.objectName || info.spaceName || info.hubName || 'Sin asignar';
  const hubName = info.hubName || event.hubId || '-';
  const sensorName = info.sourceObjectName || info.sourceObjectTypeLabel || '-';
  const occurredFmt = event.occurredAt
    ? new Date(event.occurredAt).toLocaleString('es-UY', { timeZone: 'America/Montevideo', hour12: false })
    : '-';
  const base = getPublicBaseUrl();
  const lines = [
    `[${pal.lbl}] ${event.description || event.eventCode || 'Evento Ajax'}`,
    '',
    `Cliente:   ${clientName}`,
    `Hub:       ${hubName}${event.hubId && hubName !== event.hubId ? ` (${event.hubId})` : ''}`,
    `Sensor:    ${sensorName}`,
    `Codigo:    ${event.protocol || ''} ${event.eventCode || '-'}`,
    `Cuando:    ${occurredFmt} (hora Uruguay)`,
  ];
  if (info.transition) lines.push(`Transicion: ${transitionLabel(info.transition)}`);
  lines.push('', `Ver detalle: ${base}/dashboard/#/events/${event.id}`);
  lines.push('', '-- Ajax Manager / IES');
  return lines.join('\n');
}

// ============================================================
// Config + dispatch
// ============================================================
interface EmailConfig {
  to?: string;
  from?: string;
  subjectPrefix?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpSecure?: boolean;
}

export async function dispatchEmail(event: AjaxEvent, sub: WebhookSubscription): Promise<DeliveryResult> {
  const cfg = (sub.config || {}) as EmailConfig;
  if (!cfg.to)        return { ok: false, errorMessage: 'config.to requerido (destinatarios)' };
  if (!cfg.smtpHost)  return { ok: false, errorMessage: 'config.smtpHost requerido' };
  if (!cfg.smtpUser || !cfg.smtpPass) return { ok: false, errorMessage: 'config.smtpUser y smtpPass requeridos' };

  let nodemailer: typeof import('nodemailer');
  try {
    nodemailer = require('nodemailer');
  } catch {
    return { ok: false, errorMessage: 'nodemailer no instalado. Ejecuta: npm i nodemailer' };
  }

  const sev = (event.severity || 'INFO').toUpperCase();
  const pal = SEV_PALETTE[sev] || SEV_PALETTE.UNKNOWN;
  const info = extractEventInfo(event);
  const subject = `${cfg.subjectPrefix || '[AJM]'} ${pal.emoji} ${pal.lbl} - ${event.description || event.eventCode || 'Evento Ajax'}`;
  const html = buildHtml(event, info);
  const text = buildText(event, info);

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort || 587,
      secure: cfg.smtpSecure ?? false,
      auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    });
    const result = await transporter.sendMail({
      from: cfg.from || cfg.smtpUser,
      to: cfg.to,
      subject,
      html,
      text,
      priority: sev === 'ALARM' ? 'high' : 'normal',
    });
    return { ok: true, httpStatus: 200, responseBody: `messageId: ${result.messageId}` };
  } catch (err) {
    return { ok: false, errorMessage: (err as Error).message };
  }
}
