/**
 * Routing de notificaciones por canal.
 * Cada canal implementa: dispatch(event, subscription) -> DeliveryResult
 */
import type { AjaxEvent, WebhookSubscription } from '@prisma/client';
import { dispatchHttp } from './http.channel';
import { dispatchEmail } from './email.channel';
import { dispatchSlack } from './slack.channel';
import { dispatchTelegram } from './telegram.channel';
import { dispatchScadaOpc } from './scada-opc.channel';

export interface DeliveryResult {
  ok: boolean;
  httpStatus?: number;
  errorMessage?: string;
  responseBody?: string;
}

export async function dispatchByChannel(
  event: AjaxEvent,
  sub: WebhookSubscription,
): Promise<DeliveryResult> {
  switch (sub.type) {
    case 'HTTP':       return dispatchHttp(event, sub);
    case 'EMAIL':      return dispatchEmail(event, sub);
    case 'SLACK':      return dispatchSlack(event, sub);
    case 'TELEGRAM':   return dispatchTelegram(event, sub);
    case 'SCADA_OPC':  return dispatchScadaOpc(event, sub);
    default:           return { ok: false, errorMessage: `Canal no soportado: ${sub.type}` };
  }
}
