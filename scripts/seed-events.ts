/**
 * Seed de eventos sinteticos + webhook subscriptions de ejemplo.
 *
 * Uso (dentro del container):
 *   docker exec ajm-app sh -c "cd /app && node /tmp/seed-events.cjs"
 *
 * Genera ~80 eventos repartidos en las ultimas 24h con mix realista de
 * severidades, hubs ficticios, codigos CID/SIA. Tambien crea 3 webhook
 * subscriptions a httpbin.org para que veas el dispatcher en accion.
 */
import 'dotenv/config';
import { PrismaClient, EventStatus } from '@prisma/client';

const prisma = new PrismaClient();

const HUBS = [
  { id: 'HUB-IES-001', name: 'Sitio Demo Pocitos' },
  { id: 'HUB-IES-002', name: 'Sitio Demo Centro' },
  { id: 'HUB-IES-003', name: 'Sitio Demo Carrasco' },
  { id: 'HUB-IES-004', name: 'Sitio Demo Industrial' },
  { id: 'HUB-IES-005', name: 'Sitio Demo Punta del Este' },
];

interface EventTemplate {
  code: string;
  protocol: 'CID' | 'SIA';
  description: string;
  severity: string;
}

const EVENT_TEMPLATES: EventTemplate[] = [
  { code: '130', protocol: 'CID', description: 'Intrusión detectada', severity: 'ALARM' },
  { code: '110', protocol: 'CID', description: 'Alarma de incendio', severity: 'ALARM' },
  { code: '120', protocol: 'CID', description: 'Pánico (atraco)', severity: 'ALARM' },
  { code: '113', protocol: 'CID', description: 'Inundación', severity: 'ALARM' },
  { code: '301', protocol: 'CID', description: 'Pérdida de alimentación AC', severity: 'WARNING' },
  { code: '302', protocol: 'CID', description: 'Batería baja del panel', severity: 'WARNING' },
  { code: '384', protocol: 'CID', description: 'Batería baja sensor RF', severity: 'WARNING' },
  { code: '137', protocol: 'CID', description: 'Tamper de zona', severity: 'WARNING' },
  { code: '356', protocol: 'CID', description: 'Pérdida de polling', severity: 'WARNING' },
  { code: '401', protocol: 'CID', description: 'Armado/desarmado por usuario', severity: 'INFO' },
  { code: '406', protocol: 'CID', description: 'Cancelación de alarma', severity: 'INFO' },
  { code: '602', protocol: 'CID', description: 'Test periódico', severity: 'MAINTENANCE' },
  { code: '601', protocol: 'CID', description: 'Test manual', severity: 'MAINTENANCE' },
  { code: 'BA', protocol: 'SIA', description: 'Burglary Alarm — Intrusión', severity: 'ALARM' },
  { code: 'FA', protocol: 'SIA', description: 'Fire Alarm — Incendio', severity: 'ALARM' },
  { code: 'HA', protocol: 'SIA', description: 'Holdup Alarm — Atraco', severity: 'ALARM' },
  { code: 'AT', protocol: 'SIA', description: 'AC Trouble — Pérdida de AC', severity: 'WARNING' },
  { code: 'YT', protocol: 'SIA', description: 'Battery Trouble', severity: 'WARNING' },
  { code: 'OP', protocol: 'SIA', description: 'Opening — Desarmado', severity: 'INFO' },
  { code: 'CL', protocol: 'SIA', description: 'Closing — Armado', severity: 'INFO' },
  { code: 'RP', protocol: 'SIA', description: 'Automatic Test', severity: 'MAINTENANCE' },
];

// Distribución realista: 70% INFO/MAINTENANCE, 20% WARNING, 10% ALARM
const SEVERITY_WEIGHTS: Record<string, number> = {
  ALARM: 0.10, WARNING: 0.20, INFO: 0.45, MAINTENANCE: 0.25,
};

function pickWeighted<T extends { severity: string }>(arr: T[]): T {
  const r = Math.random();
  let acc = 0;
  for (const sev of Object.keys(SEVERITY_WEIGHTS)) {
    acc += SEVERITY_WEIGHTS[sev];
    if (r <= acc) {
      const candidates = arr.filter(x => x.severity === sev);
      if (candidates.length > 0) return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min: number, max: number): number { return Math.floor(Math.random() * (max - min)) + min; }

async function seedEvents(count: number): Promise<void> {
  const now = Date.now();
  const events = [];
  for (let i = 0; i < count; i++) {
    const tpl = pickWeighted(EVENT_TEMPLATES);
    const hub = pick(HUBS);
    // Distribuir uniformemente en las últimas 24h
    const offsetMs = (i / count) * 24 * 60 * 60 * 1000 + rand(-300_000, 300_000);
    const occurredAt = new Date(now - 24*3600_000 + offsetMs);
    const receivedAt = new Date(occurredAt.getTime() + rand(100, 5000));
    events.push({
      sqsMessageId: `seed-${Date.now()}-${i}-${Math.random().toString(36).slice(2,8)}`,
      messageGroupId: hub.id,
      ajaxEventId: `evt-${Math.random().toString(36).slice(2,12)}`,
      hubId: hub.id,
      eventCode: tpl.code,
      protocol: tpl.protocol,
      description: tpl.description,
      severity: tpl.severity,
      occurredAt,
      receivedAt,
      rawPayload: {
        seed: true, hubName: hub.name, code: tpl.code,
        protocol: tpl.protocol, occurredAt: occurredAt.toISOString(),
      },
      status: EventStatus.PROCESSED,
      processedAt: receivedAt,
    });
  }
  await prisma.ajaxEvent.createMany({ data: events, skipDuplicates: true });
  console.log(`✅ ${events.length} eventos sintéticos insertados`);
}

async function seedSubscriptions(): Promise<void> {
  const subs = [
    {
      name: 'CRA - Sistema de monitoreo principal',
      url: 'https://httpbin.org/post',
      filters: { severities: ['ALARM', 'WARNING'] },
      active: true,
    },
    {
      name: 'Notificaciones Slack (#alarmas)',
      url: 'https://httpbin.org/anything/slack',
      filters: { severities: ['ALARM'] },
      secret: 'mi-secreto-hmac-de-prueba',
      active: true,
    },
    {
      name: 'Backup eventos (todos)',
      url: 'https://httpbin.org/post',
      filters: null,
      active: false, // pausado para mostrar los 2 estados
    },
  ];
  for (const s of subs) {
    await prisma.webhookSubscription.upsert({
      where: { id: '00000000-0000-0000-0000-' + s.name.slice(0,12).padStart(12,'0').replace(/[^a-f0-9]/g,'0') },
      create: s as never,
      update: { name: s.name, url: s.url, active: s.active },
    }).catch(async () => {
      // Si el upsert por ID falló (probable, IDs no son UUIDs válidos), crear simple
      const existing = await prisma.webhookSubscription.findFirst({ where: { name: s.name } });
      if (existing) {
        await prisma.webhookSubscription.update({ where: { id: existing.id }, data: { active: s.active } });
      } else {
        await prisma.webhookSubscription.create({ data: s as never });
      }
    });
  }
  console.log(`✅ ${subs.length} webhook subscriptions configuradas`);
}

async function main(): Promise<void> {
  console.log('🌱 Seeding...');
  await seedEvents(80);
  await seedSubscriptions();
  const total = await prisma.ajaxEvent.count();
  const subs = await prisma.webhookSubscription.count();
  console.log(`📊 Estado final: ${total} eventos · ${subs} subs en DB`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
