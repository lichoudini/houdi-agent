---
name: houdi-agent
description: Instala, configura, opera y diagnostica Houdi Agent en Linux, macOS y Windows (WSL). Usa este skill cuando necesites bootstrap inicial con wizard, configuración de servicio persistente, activación de bridges (Telegram/Slack/WhatsApp), verificación de salud (`/status`, `/doctor`, `/metrics`) o troubleshooting de runtime, intents y permisos.
---

# Houdi Agent

## Quick Start

1. Clonar repo y entrar al proyecto:
```bash
git clone https://github.com/lichoudini/houdi-agent.git
cd houdi-agent
```

2. Ejecutar onboarding recomendado:
```bash
./scripts/install-houdi-agent.sh
```

3. Verificar build y estado:
```bash
npm run build
npm start
```

## Flujo Operativo

1. Configurar `.env` por wizard (`npm run onboard`).
2. Definir proveedor IA (`AI_PROVIDER`) y tokens de canal.
3. Validar salud con `/status`, `/doctor`, `/health`, `/metrics`.
4. Ajustar seguridad con `DEFAULT_AGENT=operator` y elevación puntual a `admin`.
5. Activar bridges opcionales:
```bash
npm run slack:bridge
npm run whatsapp:bridge
```

## Troubleshooting Mínimo

- Si falla build: ejecutar `npm ci && npm run build`.
- Si no responde Telegram: validar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_ALLOWED_USER_IDS`.
- Si hay conflicto de instancia: revisar lock/PID y proceso activo.
- Si falla intent routing: correr tests de router y revisar `houdi-audit.log`.
- Si falla publicación segura: ejecutar `npm run guard:repo`.

## Validación de Release

Ejecutar siempre:
```bash
npm run guard:repo
npm test
```
