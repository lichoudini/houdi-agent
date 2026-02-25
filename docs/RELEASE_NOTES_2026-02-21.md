# Release Notes - 2026-02-21

Este release refuerza la robustez operativa del agente con foco en continuidad post-reinicio, resiliencia de entrega de respuestas y control de ejecución concurrente por chat.

## Resumen Ejecutivo

- Entrada serializada por chat para evitar carreras y ejecuciones superpuestas.
- Detección de loops conversacionales (repetición y ping-pong) con corte preventivo en nivel crítico.
- Outbox durable con backoff, retries programados, dead-letter y recuperación automática.
- Persistencia en SQLite del estado runtime crítico para recuperación real después de reboot/restart.
- Integración modular de mensajes de progreso (sin duplicación de lógica en `index.ts`).
- Observabilidad ampliada con comando `/metrics` y reset controlado.
- Cobertura de tests ampliada para los componentes de robustez.

## Cambios Implementados

### 1) Cola de mensajes por chat

- Nuevo módulo: `src/chat-message-queue.ts`.
- Garantiza ejecución secuencial por `chatId`.
- Exposición de profundidad y snapshot de cola para diagnóstico.
- Integración en pipeline de entrada:
  - mensajes de texto,
  - tareas disparadas por captions de archivos,
  - mensajes por audio transcripto,
  - bridge HTTP local.

### 2) Detección de loops conversacionales

- Nuevo módulo: `src/conversation-loop-detector.ts`.
- Detecta:
  - repetición consecutiva del mismo input,
  - patrón alternante tipo ping-pong.
- Niveles:
  - `warning`: continúa con observación,
  - `critical`: corta ejecución para evitar bucles.
- Eventos registrados en observabilidad y auditoría.

### 3) Outbox robusto y recuperación

- Evolución de `src/sqlite-state-store.ts`:
  - `next_attempt_at_ms` en cola outbox,
  - consulta de mensajes vencidos (`due`),
  - dead-letter table para fallos definitivos.
- Flujo de retry:
  - incremento de intentos,
  - backoff,
  - movimiento a dead-letter tras agotar retries.
- Worker de recuperación periódica + tick inicial de startup.
- Comando `/outbox` ampliado:
  - `status`,
  - `flush`,
  - `recover`.

### 4) Persistencia de estado runtime crítico

Se persiste/restaura en SQLite:

- aprobaciones pendientes,
- planes pendientes,
- confirmaciones pendientes de borrado workspace,
- solicitudes pendientes de path para borrado,
- settings runtime por chat:
  - agente activo,
  - shell mode,
  - eco mode,
  - safe mode,
  - modelo OpenAI por chat,
  - admin mode,
- setting global:
  - panic mode.

Resultado: tras reinicio del proceso, el agente recupera su contexto operativo crítico sin depender solo de memoria en RAM.

### 5) Progreso de tareas modularizado

- Nuevo módulo: `src/progress-notices.ts`.
- Eliminada lógica duplicada inline del `index.ts`.
- Selección de frases por tipo de tarea y anti-repetición por chat.

### 6) Observabilidad y comando operativo

- `src/observability.ts` ahora soporta `reset()`.
- Nuevo comando `/metrics [reset]` con snapshot de:
  - counters,
  - timings,
  - cola de entrada por chat,
  - estado global de outbox/dead-letter.
- `/status` enriquecido con:
  - depth de cola del chat,
  - cantidad de chats activos en cola,
  - dead-letter reciente de outbox.

## Cambios de Esquema SQLite

Se agregan/usan tablas y columnas nuevas:

- `outbound_message_queue.next_attempt_at_ms`
- `outbound_message_dead_letter`
- `pending_approvals`
- `pending_planned_actions`
- `pending_workspace_delete_confirmations`
- `pending_workspace_delete_path_requests`
- `chat_runtime_settings`
- `global_runtime_settings`

El código contempla inicialización/migración en startup con `CREATE TABLE IF NOT EXISTS` y controles de compatibilidad.

## Pruebas Agregadas

- `src/chat-message-queue.test.ts`
- `src/conversation-loop-detector.test.ts`
- `src/sqlite-state-store.test.ts`
- extensión de `src/observability.test.ts` (reset)

Estado de suite:

- `npm run test` pasando (27/27).

## Impacto Operativo

- Menor probabilidad de pérdida de estado tras reboot.
- Menor riesgo de ejecuciones duplicadas por concurrencia de mensajes.
- Recuperación automática de respuestas no entregadas.
- Mejor trazabilidad para diagnóstico en producción.

---

## Update: Intent Router Hardening (2026-02-21, tarde)

Se incorporaron mejoras de robustez del pipeline de enrutamiento natural:

- Router semántico híbrido con BM25, alpha adaptivo por ruta/mensaje y penalización de negativos.
- Capa jerárquica coarse->fine para reducción temprana de candidatos por dominio.
- Abstención por incertidumbre (clarificación automática) y gating tipado para parámetros requeridos.
- Soporte multi-intent secuencial con resumen final por pasos.
- Dataset de enrutamiento enriquecido con señales de capas, jerarquía, ensemble y extracción tipada.

Se agregan dos workers automáticos:

- `hard negatives miner`: mina negativos desde dataset y versiona rutas al aplicar cambios.
- `canary guard`: monitor de accuracy del canary con auto-disable por brecha sostenida.

Variables nuevas destacadas:

- `HOUDI_INTENT_ROUTER_ROUTE_ALPHA_OVERRIDES_JSON`
- `HOUDI_INTENT_ROUTER_HARD_NEGATIVES_*`
- `HOUDI_INTENT_ROUTER_CANARY_GUARD_*`

Documentación técnica nueva:

- `docs/INTENT_ROUTER_HARDENING.md`
