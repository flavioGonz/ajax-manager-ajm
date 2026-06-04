<div align="center">

<img src="public/logo.svg" alt="Ajax Manager" width="80" />

# Ajax Manager AJM

**Plataforma de monitoreo y orquestación de eventos para integraciones con Ajax Systems Cloud.**

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

</div>

---

## ¿Qué es esto?

Ajax Manager AJM es un **backend de integración + dashboard web** para empresas de monitoreo de alarmas que trabajan con **Ajax Systems**.

Resuelve cuatro problemas concretos:

1. **Recibe** los eventos que Ajax Cloud publica (intrusiones, incendios, batería baja, armado/desarmado, etc.) en tiempo real desde una cola FIFO en AWS SQS.
2. **Traduce** los códigos crudos de Ajax (Contact ID y SIA) a descripciones humanas y los enriquece con severidad y metadatos.
3. **Persiste** todo en una base de datos auditable y los **reenvía** a sistemas de terceros vía webhooks, con reintentos exponenciales y firmas HMAC.
4. **Visualiza** en un dashboard moderno con multi-usuario, roles, alarm manager y vistas en vivo de los hubs y sensores conectados.

---

## ✨ Características

### Backend
- **SQS Consumer** con long polling, ack-after-persist, idempotencia por `MessageId`
- **Cliente Ajax Cloud** con autenticación, refresh token automático y caché Redis
- **Mapper CID/SIA** con tablas pre-cargadas (intrusión, fuego, médico, mantenimiento)
- **Cola BullMQ** para despacho asíncrono a webhooks con retry exponencial
- **Firma HMAC-SHA256** opcional por webhook
- **Auditoría** de cada acción mutante (audit_logs)
- **Health checks** Kubernetes-ready (`/health`, `/ready`)

### Dashboard (SPA)
- **Multi-usuario** con roles VIEWER / OPERATOR / ADMIN
- **Auth JWT** con refresh, revoke list en Redis, rate-limit en login
- **Tema claro/oscuro** con toggle animado y persistencia
- **Sidebar contraíble** con Lucide icons
- **Alarm Manager** dedicado para alarmas activas no atendidas
- **Vistas Ajax Cloud** en vivo: hubs, sensores, clientes con ficha completa
- **Bull Board** integrado para inspección de la cola
- **Tooltips animados** con explicaciones contextuales
- **Transiciones de página** fluidas
- **Modales pulidos** con backdrop blur

### Operaciones
- **Multi-stage Docker** (Alpine, ~470 MB final)
- **Docker Compose** completo: app + Postgres + Redis
- **Migrations Prisma** versionadas
- **Logs estructurados** Pino con redacción automática de PII
- **Variables de entorno** validadas con Zod (fail-fast)

---

## 🏗 Arquitectura

```
                       AJAX SYSTEMS CLOUD                     TU INFRAESTRUCTURA
   ┌─────────────────────┐                          ┌──────────────────────────────────┐
   │ Hubs Ajax (físicos) │  ──evento──>             │                                  │
   │ Hub2/Hub2+/HubPlus  │                          │   ┌──────────────────────────┐   │
   └─────────────────────┘                          │   │ SQS Consumer             │   │
                │                                   │   │ (long polling 20s)       │◄──┼─── pull
                ▼                                   │   └────────┬─────────────────┘   │
   ┌─────────────────────┐  ──publica msgs──>       │            │                     │
   │ Ajax Translator API │                          │            ▼                     │
   └─────────────────────┘                          │   ┌──────────────────────────┐   │
                │                                   │   │ Event Processor          │   │
                ▼ encola                            │   │ - parse JSON             │   │
   ┌─────────────────────┐ ◄────────────────────────┼───┤ - mapea CID/SIA          │   │
   │ AWS SQS FIFO        │                          │   │ - persiste DB            │   │
   │ ajax-events-prod    │                          │   │ - encola webhooks        │   │
   └─────────────────────┘                          │   └────────┬─────────────────┘   │
                                                    │            │                     │
   ┌─────────────────────┐                          │            ▼                     │
   │ Ajax REST API       │  ◄───────GET hubs────────┼──┐ ┌──────────────────────┐      │
   │ /api/login          │  ◄───────GET devices─────┼──┤ │ PostgreSQL (Prisma)  │      │
   │ /api/refresh        │  ◄───────GET users───────┼──┤ │ + audit_logs         │      │
   └─────────────────────┘                          │  │ └──────────┬───────────┘      │
                                                    │  │            │                  │
                                                    │  │            ▼                  │
                                                    │  │ ┌──────────────────────┐      │
                                                    │  └─┤ Express API + JWT    │      │
                                                    │    │ /api/events          │      │
                                                    │    │ /api/ajax/*  (proxy) │      │
                                                    │    │ /api/users           │      │
                                                    │    └──────────┬───────────┘      │
                                                    │               │                  │
                                                    │               ▼                  │
                                                    │    ┌──────────────────────┐      │
                                                    │    │ Dashboard SPA        │ ◄────┼──── usuarios
                                                    │    │ (Tailwind + Lucide)  │      │     192.168.x.51:3000
                                                    │    └──────────────────────┘      │
                                                    │                                  │
                                                    │    ┌──────────────────────┐      │
                                                    │    │ BullMQ Queue (Redis) │      │
                                                    │    └──────────┬───────────┘      │
                                                    │               │                  │
                                                    │               ▼                  │
                                                    │    ┌──────────────────────┐      │
                                                    │    │ Webhook Dispatcher   │──────┼─── POST con HMAC
                                                    │    │ (retry exponencial)  │──────┼─── a sistemas
                                                    │    └──────────────────────┘      │     terceros
                                                    └──────────────────────────────────┘
```

---

## 📦 Stack tecnológico

| Capa | Tecnología | Por qué |
|------|------------|---------|
| Runtime | Node.js 20 + TypeScript 5 | Estricto, tipado, async-first |
| Framework HTTP | Express + Helmet | Maduro, CSP estricta, rate-limit |
| Auth dashboard | JWT (HS256) + bcrypt | Stateless, revocable vía Redis |
| ORM | Prisma 5 | Schema declarativo + migrations |
| DB | PostgreSQL 16 | JSONB para payloads, índices |
| Cola | BullMQ + Redis 7 | Retry pattern, dead-letter, UI |
| AWS SDK | @aws-sdk/client-sqs v3 | Long polling FIFO |
| HTTP cliente | Axios + interceptors | Refresh token automático en 401 |
| Validación | Zod | Env, request bodies, tipos derivados |
| Logging | Pino + redacción PII | JSON estructurado, filtros automáticos |
| Frontend | HTML + Tailwind 4 + Chart.js | Sin build step, SPA simple |
| Iconos | Lucide | MIT, ~1300 íconos consistentes |
| Tooltips | Tippy.js | Accesible, animaciones smooth |

---

## 🗂 Estructura del proyecto

```
.
├── docker-compose.yml              # Stack completo: app + postgres + redis
├── Dockerfile                      # Multi-stage Alpine
├── prisma/
│   ├── schema.prisma               # Modelos: User, AuditLog, AjaxEvent, Webhook*
│   └── migrations/                 # SQL versionado
├── public/
│   └── index.html                  # SPA dashboard (Tailwind + Lucide)
├── scripts/
│   ├── create-user.ts              # CLI: bootstrap admin/operator
│   ├── test-ajax-auth.ts           # Smoke test de autenticación Ajax
│   └── test-sqs-peek.ts            # Smoke test de la cola FIFO
└── src/
    ├── api/
    │   ├── server.ts               # Express app, CSP, routing
    │   ├── middlewares/
    │   │   └── auth.middleware.ts  # JWT + roles + service token
    │   └── routes/
    │       ├── auth.routes.ts      # login, logout, change-password
    │       ├── users.routes.ts     # CRUD usuarios (ADMIN)
    │       ├── events.routes.ts    # listado/detalle eventos
    │       ├── subscriptions.routes.ts # webhooks
    │       ├── system.routes.ts    # info, timeseries, deliveries
    │       ├── ajax.routes.ts      # proxy a Ajax Cloud
    │       └── bull-board.ts       # UI cola
    ├── config/
    │   └── index.ts                # Validación Zod del .env
    ├── services/
    │   ├── auth.service.ts         # bcrypt + JWT + revoke
    │   ├── audit.service.ts        # log de acciones
    │   ├── ajax-auth.service.ts    # session/refresh contra Ajax
    │   ├── ajax-api.client.ts      # axios con interceptor 401
    │   ├── ajax-cloud.service.ts   # wrappers tipados + caché
    │   ├── event-mapper.service.ts # tablas CID/SIA
    │   ├── event-processor.service.ts # SQS msg → DB → encolar
    │   └── dispatcher.service.ts   # productor BullMQ
    ├── workers/
    │   ├── sqs-consumer.ts         # long polling FIFO
    │   └── webhook-dispatcher.worker.ts # POST con retries
    ├── utils/
    │   ├── logger.ts               # Pino + redacción PII
    │   ├── prisma.ts               # singleton PrismaClient
    │   └── redis.ts                # ioredis para BullMQ
    └── index.ts                    # entry point combinado
```

---

## 🚀 Quick start

### Con Docker Compose (recomendado)

```bash
# 1. Clonar y configurar
git clone https://github.com/<tu-usuario>/ajax-manager.git
cd ajax-manager
cp .env.example .env

# 2. Editar .env con TUS credenciales (ver sección Variables abajo)
nano .env

# 3. Levantar el stack
docker compose up -d --build

# 4. Crear el primer usuario ADMIN
docker compose exec app sh -c "cd /app && npx tsx scripts/create-user.ts admin@tuempresa.com TuPasswordFuerte ADMIN 'Tu Nombre'"

# 5. Abrir el dashboard
open http://localhost:3000
```

### Sin Docker (dev local)

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run dev
```

---

## 🔐 Variables de entorno

Ver `.env.example` para la lista completa. Las críticas:

| Variable | Qué es | Cómo obtenerla |
|----------|--------|----------------|
| `JWT_SECRET` | Secreto para firmar tokens del dashboard | `openssl rand -hex 32` |
| `API_KEY_DASHBOARD` | Token para integraciones backend-a-backend | `openssl rand -hex 32` |
| `AJAX_LOGIN` | Email de tu cuenta Ajax | El que usás en la app móvil |
| `AJAX_PASSWORD` | Password de tu cuenta Ajax (en plano — el código lo hashea con SHA-256 antes de mandarlo) | El que usás en la app móvil |
| `X_API_KEY` | API key entregada por Ajax al darte de alta como integrador | Soporte Ajax Pro |
| `AJAX_INT_ID` | ID de integración asignado por Ajax | Soporte Ajax Pro |
| `AJAX_COMPANY_ID` | (Opcional) Company ID si sos empresa de monitoreo Pro | Soporte Ajax Pro |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credenciales IAM para leer la cola SQS | AWS console o entregadas por Ajax |
| `SQS_URL` | URL de la cola FIFO `ajax-events-*-prod.fifo` | Entregada por Ajax al integrarte |
| `DATABASE_URL` | Postgres connection string | `postgresql://user:pass@host:5432/db` |

> ⚠️ **Nunca commitees el archivo `.env` real.** Está excluido en `.gitignore`. Solo subí `.env.example` con valores ficticios.

---

## 👥 Roles de usuario

| Rol | Permisos |
|-----|----------|
| **VIEWER** | Ver eventos, alarmas, hubs, sensores, despachos. No puede modificar nada. |
| **OPERATOR** | Todo lo anterior + crear/editar/borrar webhooks, ver cola BullMQ. |
| **ADMIN** | Todo lo anterior + gestión de usuarios + audit log. |
| **Service Token** | Equivalente a ADMIN. Para integraciones backend-a-backend (curl, scripts). |

---

## 🔁 Flujo de un evento (paso a paso)

```
1. Sensor dispara → Hub envía a Ajax Cloud
2. Ajax Cloud publica mensaje en SQS FIFO (con MessageGroupId = hubId)
3. SQS Consumer (long polling 20s):
   - ReceiveMessage batch hasta 10
   - VisibilityTimeout 60s
4. Event Processor (por mensaje):
   - parse JSON body
   - extrae código (eventCode | code | cid | sia | event.code)
   - mapper.mapEventCode() → { description, severity }
   - prisma.ajaxEvent.upsert (idempotente por sqsMessageId)
   - dispatcher.enqueueForEvent(eventId)
5. Para cada WebhookSubscription activa que matchea filtros:
   - WebhookDelivery row con status PENDING
   - BullMQ.add('webhook-deliver', { eventId, subscriptionId })
6. SQS DeleteMessage solo si lo anterior fue OK (sino quedará revisible)
7. Webhook Dispatcher Worker:
   - construye body limpio (sin rawPayload)
   - HMAC-SHA256 si subscription.secret existe
   - POST con timeout 10s
   - Retry exponencial 5 veces (2s, 4s, 8s, 16s, 32s)
   - Updates WebhookDelivery con cada intento
   - Si agota: status DEAD_LETTER (queda 7 días para inspección)
```

---

## 📊 Modelo de datos

```sql
users(id, email UNIQUE, password_hash, full_name, role, active, last_login_at)
audit_logs(id, user_id, action, resource, metadata, ip_address, user_agent)
ajax_events(id, sqs_message_id UNIQUE, hub_id, event_code, severity, raw_payload, status, ...)
webhook_subscriptions(id, name, url, secret, filters JSONB, active)
webhook_deliveries(id, event_id, subscription_id, attempt, status, http_status, error_message)
```

Ver `prisma/schema.prisma` para definiciones completas con tipos y relaciones.

---

## 🛡 Seguridad

- **Sin secretos en código**: todo en `.env`, validado con Zod, fail-fast.
- **Redacción de PII en logs**: passwords, emails, teléfonos, headers de auth se ofuscan automáticamente vía Pino redact.
- **Rate-limit estricto en login**: 5 intentos/min/IP. 600 req/min en API general.
- **CSP estricta**: scripts solo de jsDelivr/unpkg, no eval, no inline para datos.
- **Usuario no-root** dentro del container Docker.
- **Helmet** con CSP custom (HSTS desactivado para LAN HTTP; reactivar tras TLS).
- **JWT revocable**: lista de tokens en Redis con TTL = expiración restante.
- **Webhooks firmados**: HMAC-SHA256 opcional para que el receptor verifique.
- **Idempotencia FIFO**: upsert por `MessageId` previene procesar duplicados.

---

## 🔧 Operación

### Logs en vivo
```bash
docker compose logs -f app
docker compose logs -f sqs-consumer
```

### Backup de Postgres
```bash
docker compose exec postgres pg_dump -U ajax ajax_manager | gzip > backup-$(date +%F).sql.gz
```

### Inspección Prisma Studio
```bash
docker compose exec app npx prisma studio
# Abre en http://localhost:5555
```

### Smoke tests
```bash
docker compose exec app npx tsx scripts/test-ajax-auth.ts
docker compose exec app npx tsx scripts/test-sqs-peek.ts
```

### Endpoints útiles para monitoring externo
- `GET /health` → `200 {status:"ok"}` siempre que el proceso esté vivo.
- `GET /ready` → `200 {status:"ready"}` cuando además Postgres y Redis están conectados, `503` si alguno falla.

---

## 🗺 Roadmap

- [ ] Frontend con SSE/WebSocket para push real (hoy es polling 5s)
- [ ] Notificaciones por email/SMS para alarmas no atendidas en N minutos
- [ ] Multi-tenancy completo (varios clientes en la misma instancia)
- [ ] Reverse proxy con TLS (Caddy) + reactivar HSTS
- [ ] Tests automatizados (Vitest + testcontainers)
- [ ] CI/CD (GitHub Actions: lint + typecheck + tests + build)
- [ ] Métricas Prometheus + Grafana
- [ ] Auditoría de UI (quién armó/desarmó qué)
- [ ] Mapa de hubs georreferenciado

---

## 📄 Licencia

Uso interno de Favaro. No redistribuir sin autorización.

## 🤝 Contribuciones

Issues y pull requests son bienvenidos. Antes de un PR grande:
1. `npm run typecheck` debe pasar
2. `npm run lint` sin warnings
3. Migration SQL revisada manualmente

---

<div align="center">
<sub>Hecho con 🛡️ por el equipo Favaro</sub>
</div>
