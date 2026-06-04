import axios, { AxiosError } from 'axios';
import type { AjaxEvent, WebhookSubscription } from '@prisma/client';
import { config } from '../../config';
import type { DeliveryResult } from './index';

const SEV_EMOJI: Record<string, string> = {
  ALARM: '\u{1F6A8}', WARNING: '⚠️', INFO: 'ℹ️',
  MAINTENANCE: '\u{1F527}', UNKNOWN: '\u{1F514}',
};
const SEV_LABEL: Record<string, string> = {
  ALARM: 'ALARMA', WARNING: 'ADVERTENCIA', INFO: 'INFORMATIVO',
  MAINTENANCE: 'MANTENIMIENTO', UNKNOWN: 'EVENTO',
};

function getPublicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'https://ajm.infratec.com.uy').replace(/\/$/, '');
}

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
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

interface ExtractedInfo {
  hubName?: string;
  sourceObjectName?: string;
  sourceObjectTypeRaw?: string;     // UPPER_SNAKE como viene de Ajax (matches device-images filename)
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

function buildCaption(event: AjaxEvent, info: ExtractedInfo): string {
  const sev = (event.severity || 'INFO').toUpperCase();
  const emoji = SEV_EMOJI[sev] || '\u{1F514}';
  const sevLabel = SEV_LABEL[sev] || sev;
  const occurredAt = event.occurredAt
    ? new Date(event.occurredAt).toLocaleString('es-UY', { timeZone: 'America/Montevideo', hour12: false })
    : '-';

  const clientName = info.objectName || info.spaceName || info.hubName || 'Cliente';
  const hubName = info.hubName || event.hubId || '-';
  const sensorLine = info.sourceObjectName
    ? `${info.sourceObjectName}${info.sourceObjectTypeLabel ? ` (${info.sourceObjectTypeLabel})` : ''}`
    : (info.sourceObjectTypeLabel || '-');

  const lines = [
    `${emoji} <b>${escapeHtml(sevLabel)}</b>`,
    `<b>${escapeHtml(event.description || event.eventCode || 'Evento Ajax')}</b>`,
    '',
    `\u{1F3E2} Cliente: <b>${escapeHtml(clientName)}</b>`,
    `\u{1F50C} Hub: ${escapeHtml(hubName)}${event.hubId && info.hubName ? ` <code>${escapeHtml(event.hubId)}</code>` : ''}`,
    `\u{1F4E1} Sensor: ${escapeHtml(sensorLine)}`,
    `\u{1F4CB} Codigo: <code>${escapeHtml(event.protocol || '')} ${escapeHtml(event.eventCode || '-')}</code>`,
    `⏰ ${escapeHtml(occurredAt)} (UYT)`,
  ];
  if (info.transition) {
    lines.push(`\u{1F504} Transicion: ${info.transition === 'TRIGGERED' ? 'Disparado' : info.transition === 'RECOVERED' ? 'Restaurado' : escapeHtml(info.transition)}`);
  }
  return lines.join('\n');
}

function buildInlineKeyboard(event: AjaxEvent): Array<Array<{ text: string; url?: string; callback_data?: string }>> {
  const base = getPublicBaseUrl();
  const eventUrl = `${base}/dashboard/#/events/${encodeURIComponent(event.id)}`;
  const ackUrl = `${base}/dashboard/#/alarmas?ack=${encodeURIComponent(event.id)}`;
  const isAlarm = (event.severity || '').toUpperCase() === 'ALARM';
  const row1: Array<{ text: string; url?: string }> = [
    { text: '\u{1F50D} Ver detalle', url: eventUrl },
  ];
  if (isAlarm) {
    row1.unshift({ text: '\u{2705} Reconocer', url: ackUrl });
  }
  return [row1];
}

export async function dispatchTelegram(event: AjaxEvent, sub: WebhookSubscription): Promise<DeliveryResult> {
  const cfg = (sub.config || {}) as Record<string, string>;
  const botToken = cfg.botToken;
  const chatId = cfg.chatId;
  if (!botToken || !chatId) {
    return { ok: false, errorMessage: 'botToken y chatId requeridos para Telegram' };
  }

  const info = extractEventInfo(event);
  const caption = buildCaption(event, info);
  // Si el evento tiene foto local cacheada (MotionCam), usarla. Sino, el icono PNG del modelo o Hub.
  const raw = (event.rawPayload || {}) as Record<string, unknown>;
  const localPhotos = Array.isArray(raw.__localPhotos) ? raw.__localPhotos as Array<{ url: string }> : [];
  // Los archivos en /app/data/device-images/ estan en UPPER_SNAKE (HUB.png, MOTION_CAM.png)
  const iconName = info.sourceObjectTypeRaw || 'HUB';
  const fallbackIcon = `${getPublicBaseUrl()}/device-images/${encodeURIComponent(iconName)}.png`;
  const photoUrl = localPhotos.length > 0
    ? `${getPublicBaseUrl()}${localPhotos[0].url}`
    : fallbackIcon;
  const isRealPhoto = localPhotos.length > 0;
  const silentNotif = event.severity === 'INFO' || event.severity === 'MAINTENANCE';

  try {
    // sendMessage con link_preview_options.prefer_small_media=true
    // Esto muestra el icono del sensor como mini-thumbnail al costado del mensaje
    // en lugar de la foto gigante que generaba sendPhoto.
    const res = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        disable_notification: silentNotif,
        // Solo mostramos preview cuando hay foto REAL del MotionCam (la queremos grande arriba).
        // Para eventos sin foto real, NO mostramos preview - el icono PNG se ve gigante en Telegram
        // (prefer_small_media solo funciona para preview tipo "card" de paginas web con OG tags,
        // no para URLs directas de imagen).
        link_preview_options: isRealPhoto
          ? { url: photoUrl, prefer_large_media: true, show_above_text: true }
          : { is_disabled: true },
        reply_markup: {
          inline_keyboard: buildInlineKeyboard(event),
        },
      },
      { timeout: config.WEBHOOK_TIMEOUT_MS },
    );
    return { ok: true, httpStatus: res.status };
  } catch (err) {
    const ax = err as AxiosError;
    return {
      ok: false,
      httpStatus: ax.response?.status,
      errorMessage: ax.message + (ax.response?.data ? ' :: ' + JSON.stringify(ax.response.data).slice(0, 200) : ''),
    };
  }
}
