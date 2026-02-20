# Houdi Agent - Project Overview

## Objetivo
Houdi Agent es un bot de Telegram para operar una PC Linux de forma controlada, con ejecución de comandos restringida por agente y aprobación explícita para acciones sensibles.

## Alcance actual
- Bot Telegram con comandos operativos (`/status`, `/exec`, `/tasks`, `/kill`).
- Modo IA conversacional (`/ask`) y modo shell asistido (`/shell`, `/shellmode`).
- Ingesta de archivos adjuntos:
  - guarda documentos en `workspace/files/...`
  - guarda imágenes en `workspace/images/...`
  - análisis visual de imágenes con OpenAI (si está configurado)
- Operaciones de archivos/carpetas en `workspace` por comando (`/workspace ...`) o lenguaje natural (listar, crear, mover, renombrar, eliminar).
- Memoria operativa en archivos:
  - notas diarias (`memory/YYYY-MM-DD.md`)
  - memoria de largo plazo (`MEMORY.md`)
  - comandos `/remember` y `/memory ...`
- Contexto de personalidad/lineamientos por workspace (`AGENTS.md`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`).
- Skills dinámicas con lenguaje natural, incluyendo borrador multi-mensaje para crear habilidades en pasos.
- Aprendizaje local de intereses por recurrencia de pedidos + sugerencias proactivas con cuota diaria configurable.
- Control de riesgo por capas:
  - allowlist por agente (`agents/*.json`)
  - `adminmode` con aprobaciones (`/approve`, `/deny`)
  - `panic mode` para bloqueo global
- Reinicio remoto con confirmación (`/reboot`) cuando está habilitado.
- Onboarding por CLI (`npm run onboard`) para setup guiado de `.env` y despliegue inicial.
- Auditoría básica en archivo JSONL (`houdi-audit.log`).

## Stack técnico
- Node.js + TypeScript
- `grammy` para Telegram
- `openai` para respuestas y planificación de shell
- `zod` para validación de configuración
- `systemd` para operación en producción

## Estructura del repositorio
- `src/`: lógica principal del bot
- `agents/`: perfiles de permisos por agente
- `scripts/`: instalación y operación (systemd, checks, backup)
- `docs/`: documentación de arquitectura y operación

## Estado de despliegue recomendado
- Servicio `systemd` de sistema (`houdi-agent.service`)
- Arranque automático en boot (`WantedBy=multi-user.target`)
- Reinicio remoto vía `sudo -n /usr/bin/systemctl reboot` con política mínima en `sudoers`

## Próximas mejoras sugeridas
1. Persistencia en SQLite para tareas, aprobaciones y eventos.
2. Tests automatizados para parser, approvals y task runner.
3. Políticas por chat/rol más finas (RBAC).
4. Endpoints de healthcheck para monitoreo externo.
