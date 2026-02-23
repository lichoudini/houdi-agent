# Houdi Agent - Architecture

## Componentes
- `src/index.ts`
  - Entrypoint del bot
  - Registro de comandos Telegram
  - Pipeline de intención natural (documentos, web, Gmail) antes del fallback general de chat
  - API local `POST /internal/cli/message` para reutilizar el mismo pipeline desde CLI
  - Orquestación de agentes, aprobaciones y ejecución
- `src/cli.ts`
  - Entrada CLI local (`npm run cli`) para consultar al agente sin Telegram
  - `transport=auto|bridge|local` para paridad con Telegram cuando el bridge está activo
  - Modo one-shot y chat interactivo
  - Comandos de memoria (`memory status/search/view`, `remember`)
- `src/onboard.ts`
  - Wizard interactivo de instalación (`npm run onboard`)
  - Setup guiado de `.env` (Telegram, Gmail, workspace, bridge local, WhatsApp bridge y conector externo opcional)
  - Opcionalmente instala dependencias/build y servicio systemd
- `src/whatsapp-bridge.ts`
  - Bridge de WhatsApp Cloud API (webhook verify + inbound + outbound)
  - Forward al pipeline principal vía `POST /internal/cli/message`
  - Dedupe de eventos y validación opcional de firma HMAC (`X-Hub-Signature-256`)
- `src/config.ts`
  - Carga y validación de `.env`
- `src/agents.ts`
  - Registro de perfiles de agente y allowlists
- `src/task-runner.ts`
  - Ejecución de procesos (`spawn`, `shell: false`)
  - Timeout, captura de stdout/stderr y kill de tareas
- `src/openai-client.ts`
  - Consultas IA (`/ask`)
  - Planeación de acción shell (`/shell`)
  - Visión sobre imágenes (análisis de fotos/adjuntos)
  - Soporte de modelo override por llamada (además del default de `.env`)
  - Construcción de prompt estructurado (personalidad, lineamientos, memoria, runtime)
- `src/gmail-account.ts`
  - Conexión OAuth2 contra Gmail API
  - Listado/lectura/envío y operaciones de etiquetas (read/unread/star/trash)
- `src/scheduled-tasks-sqlite.ts`
  - Persistencia de recordatorios/tareas programadas en SQLite
  - Listado/edición/eliminación por chat
  - Gestión de retries de entrega
- `src/email-recipients-sqlite.ts`
  - Persistencia de destinatarios Gmail por chat en SQLite
- `src/sqlite-state-store.ts`
  - Estado operativo auxiliar en SQLite (idempotencia, contexto de listas indexadas, etc.)
- `src/domains/gmail/*`
  - Parsing/intents de Gmail y destinatarios
- `src/domains/workspace/*`
  - Servicios e intents de operaciones de workspace
- `src/domains/router/*`
  - Filtro contextual y `route layers` (pre-filtros por contexto fuerte)
  - Filtro jerarquico coarse->fine para reducir candidatos por dominio macro
  - Ensemble de decisión (semántico + AI judge + capas + boosts)
  - Gate de parametros requeridos para intents sensibles
  - Modo multi-intent secuencial para instrucciones encadenadas
  - Calibración de confianza por bins y archivo persistente
  - Rutas dinámicas por chat (overrides de utterances/threshold)
  - Soporte de experimento A/B por chat con split estable
  - Observabilidad: confusión, drift y alertas de precisión
  - Workers de fondo:
    - hard negatives mining desde dataset
    - canary guard con auto-disable por brecha sostenida
- `src/domains/domain-registry.ts`
  - Registro explícito de dominios cargados (router/workspace/gmail)
  - Inventario de capacidades por dominio (`/domains`)
- `src/agent-policy.ts`
  - Política declarativa de capacidades sensibles (`preview`, `approval`, `safe-block`)
  - Config por archivo (`HOUDI_AGENT_POLICY_FILE`)
- `src/agentic-canary.ts`
  - Rollout determinista por chat para controles agénticos (`/agenticcanary`)
- `src/selfskill-drafts.ts`
  - Borrador persistente de habilidades en múltiples mensajes por chat
  - Soporte start/add/show/apply/cancel
- `src/domains/selfskill/natural.ts`
  - Parser natural de skills: extracción de instrucción, comandos de borrador y heurística anti-colisión
- `src/domains/selfskill/intents.ts`
  - Detección de intenciones de mantenimiento (add/list/delete skill, restart, update)
- `src/domains/selfskill/store.ts`
  - Persistencia robusta en `workspace/AGENTS.md` para agregar/listar/eliminar skills dinámicas
- `src/interest-learning.ts`
  - Aprendizaje de gustos/intereses por recurrencia de pedidos
  - Perfil por chat con categorías y keywords
  - Cuota diaria de sugerencias proactivas
- `src/agent-context-memory.ts`
  - Workspace bootstrap (`AGENTS.md`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`, `MEMORY.md`)
  - Carga de contexto inyectado
  - Recall híbrido de memoria (`MEMORY.md` + `memory/*.md`) con scoring lexical+semántico, recencia y MMR
  - Backend de búsqueda con fallback (`hybrid` -> `scan`)
  - Flush de continuidad antes de razonar para reducir pérdida de contexto
  - Escritura de memoria diaria (`/remember`)
- `src/admin-security.ts`
  - `adminmode`, aprobaciones y `panic mode` (con restore desde estado persistido)
- `src/audit-log.ts`
  - Registro de eventos en formato JSONL
- `src/doctor.ts`
  - Healthchecks operativos de runtime/config/permisos (`/doctor`)
- `src/openai-usage.ts`
  - Agregación de tokens y costo estimado por modelo/fuente (`/usage`, `/status`)
- `src/run-trace.ts`
  - Trazas por ejecución con `run_id` y métricas de duración/estado
- `src/single-instance-lock.ts`
  - Bloqueo de instancia única para evitar conflicto de polling
- `src/sqlite-state-store.ts`
  - Cola durable de outbox para respuestas fallidas y reintentos (`/outbox`)
  - Snapshot/restore de estado runtime crítico por chat y global (modos, modelo, acciones pendientes)

## Flujo de ejecución
1. Mensaje llega por Telegram/Slack/WhatsApp (según canal activo).
2. Se valida `userId` autorizado.
3. Según comando:
   - consulta IA
   - ejecución de comando
   - operación de seguridad (approve/deny/panic)
   - operación de memoria (`/remember`, `/memory ...`)
   - operación de agenda/tareas (`/task ...`)
   - operación de archivos de workspace (`/workspace ...` o lenguaje natural)
   - operación Gmail (`/gmail ...`)
4. Para ejecutar:
   - se valida allowlist del agente activo
   - si `adminmode=on`, se encola aprobación
   - si se aprueba, se ejecuta y se reporta resultado
5. Para consultas IA:
   - se arma contexto de workspace
   - se hace recall de memoria relevante
   - se envía prompt estructurado al modelo
6. Se registra evento de auditoría cuando aplica.
7. Pipeline natural del router:
   - route layers
   - filtro jerarquico
   - filtro contextual
   - score semantico hibrido (cosine + BM25 + char n-gram + negativos)
   - ensemble + calibracion de confianza
   - abstencion por incertidumbre o aclaracion tipada
8. Loop interno revisa tareas vencidas y envía recordatorios automáticamente por Telegram.
9. Loop interno opcional de sugerencias proactivas:
   - evalúa recurrencia/intereses por chat
   - respeta cuota diaria e intervalo mínimo
   - puede sugerir web/tareas/correo de forma espontánea
10. Workers de robustez de router:
   - minado de hard negatives (persistencia de rutas + snapshot)
   - guard de canary (desactivación automática si cae accuracy)
11. Inbound media:
   - Imágenes: se guardan en `workspace/images/chat-<id>/YYYY-MM-DD/` y se analizan con IA si está configurada.
   - Archivos (document): se guardan en `workspace/files/chat-<id>/YYYY-MM-DD/`.

## Seguridad (MVP)
- Allowlist explícita por comando.
- Sin shell interactivo (`spawn` sin `shell`).
- Aprobación previa para operaciones sensibles.
- Corte global con `panic mode`.
- `reboot` siempre con aprobación.

## Calidad y CI
- `.github/workflows/ci.yml`
  - Build + tests en cada push/PR
  - Benchmark de intent-router en PR para detectar regresiones
- `.github/workflows/workflow-sanity.yml`
  - Valida higiene/lint de workflows de GitHub Actions
- `.github/workflows/secret-scan.yml`
  - Escaneo de secretos con Gitleaks

## Limitaciones actuales
- El router depende de calidad de etiquetas en dataset (`finalHandler`) para auto-mejorar.
- La calibración de confianza requiere volumen de muestras por ruta para ser estable.
- Auditoría en archivo local sin rotación automática.
