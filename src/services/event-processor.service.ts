import { Message } from '@aws-sdk/client-sqs';
import { prisma } from '../utils/prisma';
import { logger, summarizeAjaxPayload } from '../utils/logger';
import { extractEventCode, mapEventCode } from './event-mapper.service';
import { dispatcherService } from './dispatcher.service';
import { emitEventNew } from '../realtime/socket';
import { opcServerService } from './opc-server.service';
import { scheduleCachePhotos } from './photo-cache.service';
import { schedulePushForEvent } from './push.service';

export async function processSqsMessage(message: Message): Promise<boolean> {
  if (!message.MessageId || !message.Body) {
    logger.warn({ messageId: message.MessageId }, 'Mensaje SQS sin Body - descartado');
    return true;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.Body);
  } catch (err) {
    logger.error({ messageId: message.MessageId, err: (err as Error).message }, 'Body no es JSON valido');
    return true;
  }

  // Ajax SQS envia el payload envuelto: { event: {...}, recipient: {...} }
  const root = payload as Record<string, unknown>;
  const ev = (root.event && typeof root.event === 'object'
    ? (root.event as Record<string, unknown>)
    : root);
  const code = extractEventCode(payload);
  const mapped = mapEventCode(code, ev);
  const summary = summarizeAjaxPayload(payload);
  logger.info(
    { messageId: message.MessageId, ...summary, severity: mapped.severity, eventTag: ev.eventTag },
    'Evento SQS recibido',
  );

  try {
    const event = await prisma.ajaxEvent.upsert({
      where: { sqsMessageId: message.MessageId },
      create: {
        sqsMessageId: message.MessageId,
        messageGroupId: message.Attributes?.MessageGroupId,
        ajaxEventId: typeof ev.eventId === 'string'
          ? (ev.eventId as string)
          : (root.id as string | undefined),
        hubId: (ev.hubId ?? ev.spaceId ?? root.hubId ?? root.objectId) as string | undefined,
        eventCode: mapped.code || (typeof ev.eventCode === 'string' ? (ev.eventCode as string) : null),
        protocol: mapped.protocol,
        description: mapped.description,
        severity: mapped.severity,
        occurredAt: parseDate(ev.timestamp ?? ev.occurredAt ?? root.timestamp ?? root.occurredAt),
        rawPayload: payload as object,
        status: 'PROCESSED',
        processedAt: new Date(),
      },
      update: { status: 'PROCESSED', processedAt: new Date() },
    });

    emitEventNew({
      id: event.id,
      sqsMessageId: event.sqsMessageId,
      hubId: event.hubId,
      eventCode: event.eventCode,
      protocol: event.protocol,
      description: event.description,
      severity: event.severity,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      status: event.status,
    });

    await dispatcherService.enqueueForEvent(event.id);

    // Fire-and-forget: descargar fotos MotionCam mientras los signed URLs sigan validos
    scheduleCachePhotos(event.id);

    // Fire-and-forget: push notification al navegador del usuario
    schedulePushForEvent(event);

    try {
      opcServerService.publishEvent({
        hubId: event.hubId,
        eventCode: event.eventCode,
        protocol: event.protocol,
        severity: event.severity,
        description: event.description,
        occurredAt: event.occurredAt,
      });
    } catch (_e) { /* ignore */ }

    return true;
  } catch (err) {
    logger.error(
      { messageId: message.MessageId, err: (err as Error).message },
      'Error procesando evento - mensaje queda visible',
    );
    return false;
  }
}

function parseDate(input: unknown): Date | null {
  if (!input) return null;
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
