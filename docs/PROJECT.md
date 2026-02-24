# Houdi Agent - Project Overview

Versión actual: **0.63b**  
Autores del repositorio: **Houdi Contributors**

## Objetivo
Houdi Agent es un agente operativo para Telegram/Slack/WhatsApp orientado a automatizar tareas en una PC Linux con controles de seguridad por capas, auditoría y operación continua.

## Estado actual (resumen)

- Runtime principal en Node.js + TypeScript, con transporte Telegram y bridge opcional para Slack y WhatsApp Cloud API.
- Pipeline de intención híbrido (reglas + router semántico + fallback IA) para operar en lenguaje natural.
- Persistencia de estado en SQLite para contexto crítico de operación.
- Modo de seguridad por agentes (`operator` por defecto, `admin` para elevación puntual) con allowlist y aprobaciones explícitas.
- Integraciones productivas: Gmail, web browsing/documentos, tareas programadas, memoria y control CONNECTOR.

## Capacidades funcionales

- Conversación IA y ejecución asistida:
  - `/ask`, chat natural y análisis contextual por historial.
  - Soporte multi-proveedor IA (OpenAI, Claude, Gemini) con selección global por `AI_PROVIDER`.
  - `/shell` y `/shellmode` (siempre restringido por allowlist del agente activo).
  - Selección dinámica de modelo por chat con `/model` y alias `/mode`.
  - Modo ECO por chat (`/eco`) para respuestas compactas y control de costo/tokens.
- Archivos y documentos:
  - Operaciones en `workspace/` por comandos y lenguaje natural (`list`, `mkdir`, `write`, `mv`, `rename`, `rm`, `send`, `read`).
  - Atajos `/files` y `/images` para listar y navegar adjuntos guardados.
  - Lectura de PDF/Office + consultas sobre contenido con `/readfile` y `/askfile`.
- Productividad:
  - Tareas programadas (`/task`) y recordatorios con parsing natural de fecha/hora.
  - Integración Gmail (listado, lectura, draft, envío, reply/forward, libreta de destinatarios).
  - Integración CONNECTOR (`/connector`) para consulta operativa y listado de historial (`/connector list`).
- Memoria y aprendizaje:
  - Notas y memoria operativa (`/remember`, `/memory ...`).
  - Aprendizaje local de intereses y sugerencias proactivas con cuota diaria.
  - Self-skill pipeline para crear, listar y eliminar habilidades dinámicas.
- Seguridad y gobernanza:
  - Control por perfil de agente (`/agent set operator|admin`), planes pendientes y aprobaciones (`/approvals`, `/approve`, `/deny`).
  - `safe mode`, `panic mode`, auditoría estructurada (`houdi-audit.log`) y métricas de observabilidad.
  - Protección de idempotencia/outbox para evitar efectos duplicados ante reintentos.

## Persistencia y datos

- Base de estado SQLite (`workspace/state/houdi-state.sqlite` por defecto):
  - settings por chat (agente activo, shellmode, safe, eco, modelo IA),
  - outbox y dead-letter,
  - idempotencia,
  - contexto de listas indexadas para referencias tipo "abrí el 2",
  - tareas programadas y estado operativo auxiliar.
- Archivos de workspace:
  - `workspace/files/` y `workspace/images/` para adjuntos entrantes.
  - `workspace/state/` para rutas/versionado/calibración de router.

## Arquitectura de alto nivel

- Entrada:
  - Telegram (polling), Slack bridge (Socket Mode) y WhatsApp bridge (Webhook + Cloud API).
- Núcleo:
  - normalización y clasificación de interacción,
  - route narrowing por capas,
  - enrutado por dominio (gmail, workspace, document, web, connector, schedule, memory, self-maintenance),
  - ejecución de acción con policy checks y auditoría.
- Salida:
  - respuestas largas segmentadas,
  - texto "touch-friendly" para copiar IDs/rutas con menos fricción en móvil.

## Operación recomendada

- Usar `npm run onboard` o `./scripts/install-houdi-agent.sh` para setup inicial.
- Ejecutar como servicio `systemd` (user o system según perfil de despliegue).
- Mantener secretos fuera de Git (`.env`) y rotar tokens al compartir entornos.
- Verificar salud con `/status`, `/doctor`, `/metrics` y runbook en `docs/RUNBOOK.md`.
