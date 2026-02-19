# Houdi Agent - Project Overview

## Objetivo
Houdi Agent es un bot de Telegram para operar una PC Linux de forma controlada, con ejecución de comandos restringida por agente y aprobación explícita para acciones sensibles.

## Alcance actual
- Bot Telegram con comandos operativos (`/status`, `/exec`, `/tasks`, `/kill`).
- Modo IA conversacional (`/ask`) y modo shell asistido (`/shell`, `/shellmode`).
- Control de riesgo por capas:
  - allowlist por agente (`agents/*.json`)
  - `adminmode` con aprobaciones (`/approve`, `/deny`)
  - `panic mode` para bloqueo global
- Reinicio remoto con confirmación (`/reboot`) cuando está habilitado.
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
