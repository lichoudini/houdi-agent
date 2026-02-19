# Houdi Agent - Architecture

## Componentes
- `src/index.ts`
  - Entrypoint del bot
  - Registro de comandos Telegram
  - Orquestación de agentes, aprobaciones y ejecución
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
- `src/admin-security.ts`
  - `adminmode`, aprobaciones en memoria y `panic mode`
- `src/audit-log.ts`
  - Registro de eventos en formato JSONL
- `src/single-instance-lock.ts`
  - Bloqueo de instancia única para evitar conflicto de polling

## Flujo de ejecución
1. Mensaje llega por Telegram.
2. Se valida `userId` autorizado.
3. Según comando:
   - consulta IA
   - ejecución de comando
   - operación de seguridad (approve/deny/panic)
4. Para ejecutar:
   - se valida allowlist del agente activo
   - si `adminmode=on`, se encola aprobación
   - si se aprueba, se ejecuta y se reporta resultado
5. Se registra evento de auditoría cuando aplica.

## Seguridad (MVP)
- Allowlist explícita por comando.
- Sin shell interactivo (`spawn` sin `shell`).
- Aprobación previa para operaciones sensibles.
- Corte global con `panic mode`.
- `reboot` siempre con aprobación.

## Limitaciones actuales
- Aprobaciones y estado en memoria (se pierden al reinicio).
- Auditoría en archivo local sin rotación automática.
- Sin pruebas automatizadas en CI.
