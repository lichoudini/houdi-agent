# Houdi Agent (Telegram + agentes locales)

Proyecto base desde cero para arrancar un asistente de operación de PC por Telegram, con una arquitectura simple que puedas escalar.

## Documentación

- `docs/PROJECT.md`: visión general del proyecto
- `docs/ARCHITECTURE.md`: arquitectura y flujo interno
- `docs/RUNBOOK.md`: operación diaria, rollout y troubleshooting

## Enfoque de seguridad del MVP

- Solo usuarios de Telegram autorizados (`TELEGRAM_ALLOWED_USER_IDS`)
- Ejecución **sin shell** (`spawn`), para reducir inyección
- Permisos por agente (`agents/*.json`) con allowlist de comandos
- Timeout por tarea

Este MVP **no** implementa “control total irrestricto”. Está pensado como base segura para crecer.

## Requisitos

- Node.js 22+
- Un bot token de Telegram (BotFather)
- Tu user ID de Telegram
- (Opcional) API key de OpenAI para `/ask`

## Configuración

1. Instalar dependencias:

```bash
npm install
```

2. Crear `.env`:

```bash
cp .env.example .env
```

3. Completar variables en `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_IDS` (ej. `123456789` o `123456789,987654321`)
- `OPENAI_API_KEY` (opcional, necesaria para `/ask`)
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_MAX_OUTPUT_TOKENS` (default: `800`)
- `ADMIN_APPROVAL_TTL_SECONDS` (default: `300`)
- `AUDIT_LOG_PATH` (default: `./houdi-audit.log`)
- `ENABLE_REBOOT_COMMAND` (default: `false`)
- `REBOOT_COMMAND` (default: `systemctl reboot`)

## Ejecutar

Modo desarrollo:

```bash
npm run dev
```

Build + run:

```bash
npm run build
npm start
```

Importante: ejecuta solo **una instancia** del bot a la vez.
Si intentas levantar otra, Houdi Agent lo bloqueará para evitar conflictos de Telegram polling.

## Comandos Telegram

- `/status`
- `/agent`
- `/agent set <nombre>`
- `/ask <pregunta>`
- `/shell <instrucción>`
- `/shellmode on|off`
- `/exec <comando> [args]`
- `/reboot` (`/reboot status`)
- `/adminmode on|off`
- `/approvals`
- `/approve <id>`
- `/deny <id>`
- `/panic on|off|status`
- `/tasks`
- `/kill <taskId>`

También puedes escribir mensajes normales (sin `/`) y el bot responderá con OpenAI.
Si activas `/shellmode on`, esos mensajes también podrán disparar ejecución shell (siempre limitada por la allowlist del agente activo).

## Modo Admin Seguro

1. Activa aprobación previa:

```bash
/adminmode on
```

2. Cuando pidas ejecución (`/exec` o shell IA), el bot creará una solicitud con ID.

3. Acepta o rechaza:

```bash
/approve <id>
/deny <id>
```

4. Si necesitas corte total:

```bash
/panic on
```

`/panic on` bloquea nuevas ejecuciones, limpia aprobaciones pendientes y mata tareas activas.

## Reinicio Remoto Seguro

1. En `.env`, habilita:

```env
ENABLE_REBOOT_COMMAND=true
REBOOT_COMMAND=sudo -n /usr/bin/systemctl reboot
```

2. Usa `adminmode` para exigir confirmación:

```bash
/adminmode on
/agent set admin
/reboot
/approve <id>
```

El bot nunca ejecuta `/reboot` directo: siempre genera aprobación primero.

## Arranque Automático Tras Reinicio (Robusto, recomendado)

Usa servicio **systemd de sistema** (no `--user`), para que arranque al boot
aunque no se abra sesión.

Instalar:

```bash
cd /home/houdi/houdi-agent
npm run build
sudo ./scripts/install-systemd-system-service.sh
```

Ver estado:

```bash
sudo systemctl status houdi-agent.service --no-pager
```

Ver logs:

```bash
sudo journalctl -u houdi-agent.service -f
```

Desinstalar:

```bash
cd /home/houdi/houdi-agent
sudo ./scripts/uninstall-systemd-system-service.sh
```

## Arranque con systemd user (alternativa)

Solo recomendable si aceptas depender de sesión de usuario o de `linger`.

```bash
cd /home/houdi/houdi-agent
./scripts/install-systemd-user-service.sh
sudo loginctl enable-linger $USER
```

## Checklist Post-Reboot (30s)

Valida estado del servicio, instancia única y configuración clave:

```bash
cd /home/houdi/houdi-agent
./scripts/check-post-reboot.sh
```

Si devuelve `FAIL`, corrige antes de usar `/reboot`.

## Export de Configuración Crítica (sin secretos)

Genera snapshot en `backups/` con:
- unidad systemd visible por usuario
- `.env` sanitizado (`TELEGRAM_BOT_TOKEN` y `OPENAI_API_KEY` redacted)
- perfiles de agentes
- manifiesto con checksums

```bash
cd /home/houdi/houdi-agent
./scripts/export-houdi-config.sh
```

También crea `manual-root-backup.txt` con comandos para respaldar archivos root-only.

## Si deja de responder

1. Mata instancias duplicadas:

```bash
pkill -f "npm run dev" || true
pkill -f "node dist/index.js" || true
```

2. Inicia una sola:

```bash
npm run dev
```

## Estructura

- `src/index.ts`: bot Telegram + comandos
- `src/task-runner.ts`: ejecución y tracking de tareas
- `src/agents.ts`: carga y validación de perfiles de agente
- `agents/*.json`: permisos por agente

## Roadmap recomendado

1. Pairing explícito (en vez de allowlist fija)
2. Bitácora persistente de tareas (SQLite)
3. Políticas por chat/agent (RBAC)
4. Cola de trabajos y workers separados
5. Plugin system para acciones (archivos, browser, RDP, etc.)
