# Houdi Agent - Instalación en Otra PC

Versión actual: **0.63b**  
Autores del repositorio: **Nazareno Tomaselli & Vrand**

Esta guía deja una instalación reproducible para que cualquier persona pueda correr su propia instancia.

## 1. Requisitos

- Linux con `systemd` (Ubuntu/Debian recomendado).
- Node.js 22+ y `npm`.
- Cuenta de Telegram con bot token.
- User ID de Telegram autorizado.
- (Opcional) clave de proveedor IA (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` o `GEMINI_API_KEY`).
- (Opcional) credenciales OAuth de Gmail.

## 2. Clonar proyecto

```bash
git clone https://github.com/lichoudini/houdi-agent.git houdi-agent
cd houdi-agent
```

## 3. Instalar dependencias

```bash
npm install
```

## 4. Configurar entorno (wizard recomendado)

Instalador recomendado:

```bash
./scripts/install-houdi-agent.sh
```

Por default abre wizard **modo simple** (recomendado para primera instalación).
Si necesitas ver todos los parámetros técnicos:

```bash
./scripts/install-houdi-agent.sh --wizard-mode advanced
```

Automatizado (sin preguntas):

```bash
TELEGRAM_BOT_TOKEN="<token>" TELEGRAM_ALLOWED_USER_IDS="123456789" \
./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build
```

Instalación guiada en un comando (wizard paso a paso, sin editar `.env` manualmente):

```bash
git clone https://github.com/lichoudini/houdi-agent.git && cd houdi-agent && ./scripts/install-houdi-agent.sh
```

One-command install (bot + WhatsApp bridge):

```bash
git clone https://github.com/lichoudini/houdi-agent.git && cd houdi-agent && \
TELEGRAM_BOT_TOKEN="<token>" TELEGRAM_ALLOWED_USER_IDS="123456789" \
WHATSAPP_VERIFY_TOKEN="<verify-token>" WHATSAPP_ACCESS_TOKEN="<meta-token>" \
./scripts/install-houdi-agent.sh --yes --accept-risk --service-mode user --install-deps --build --with-whatsapp-bridge
```

Alternativa directa al wizard:

```bash
npm run onboard
```

Alias:

```bash
./scripts/houdi-onboard.sh
```

Esto genera/actualiza `.env` con todas las variables necesarias.
El wizard ahora incluye preflight (Node/npm/systemd/proyecto), resumen de riesgos y checklist final con próximos pasos.
Incluye dos niveles:
- `simple` (default): menos decisiones, defaults recomendados, foco en quedar operativo rápido.
- `advanced`: muestra todos los parámetros para ajuste fino.
También incluye configuración opcional de bridge WhatsApp (`WHATSAPP_*`) y opción de instalar su servicio `systemd --user`.
También soporta flags `--with-whatsapp-bridge` y `--with-slack-bridge` para dejar servicios bridge instalados al finalizar.
Para usuarios no experimentados, este flujo guiado evita editar `.env` de forma manual.
Si usas `--yes`, toma valores desde:
1) variables de entorno del proceso, 2) `.env` actual, 3) `.env.example` como fallback.
Si falta un valor obligatorio, falla con mensaje explícito indicando qué variable definir.

### 4.1 Configuración IA (OpenAI / Claude / Gemini)

El wizard pregunta el proveedor principal con `AI_PROVIDER`:

- `auto`: fallback automático en orden OpenAI -> Claude -> Gemini.
- `openai`: fuerza OpenAI.
- `claude`: fuerza Anthropic (internamente `anthropic`).
- `gemini`: fuerza Gemini.

Variables nuevas:

- `AI_PROVIDER=auto|openai|anthropic|gemini`
- `OPENAI_API_KEY` + `OPENAI_MODEL`
- `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`
- `GEMINI_API_KEY` + `GEMINI_MODEL`

Notas:

- Texto y visión funcionan con OpenAI, Claude y Gemini.
- Transcripción de audio requiere OpenAI (`OPENAI_API_KEY` + `OPENAI_AUDIO_MODEL`).
- Puedes cambiar modelo por chat en runtime con `/model set <modelo>`.

## 5. Ejecutar en local (smoke test)

```bash
npm run build
npm start
```

Validar desde Telegram:

1. `/status`
2. `/agent`
3. `/model`
4. `/ask hola`
5. `/memory`
6. `/web noticias ia hoy`

Detener con `Ctrl+C` cuando la prueba esté OK.

## 6. Instalar servicio persistente

Opción A. Servicio de usuario (sin root):

```bash
./scripts/install-systemd-user-service.sh
```

Este servicio queda con `Restart=on-failure` y límites de reintentos (evita loops de reinicio).

Para que inicie tras reboot aunque no haya sesión abierta:

```bash
sudo loginctl enable-linger $USER
```

Opción B. Servicio de sistema (recomendado para producción):

```bash
npm run build
sudo ./scripts/install-systemd-system-service.sh
```

También usa `Restart=on-failure` con límites configurables por env:
`RESTART_POLICY`, `RESTART_SEC`, `START_LIMIT_INTERVAL`, `START_LIMIT_BURST`.

## 7. Verificación operativa

Servicio de sistema:

```bash
systemctl status houdi-agent.service --no-pager
journalctl -u houdi-agent.service -n 100 --no-pager
```

Servicio de usuario:

```bash
systemctl --user status houdi-agent.service --no-pager
journalctl --user -u houdi-agent.service -n 100 --no-pager
```

## 7.1 Slack (opcional)

Houdi puede recibir mensajes desde Slack usando bridge Socket Mode (proceso separado).

1. Configurar tokens en `.env`:
   - `SLACK_BOT_TOKEN=xoxb-...`
   - `SLACK_APP_TOKEN=xapp-...`
2. Verificar que el bridge local de Houdi esté activo (`HOUDI_LOCAL_API_ENABLED=true`).
3. Levantar bridge Slack:

```bash
npm run slack:bridge
```

Para dejarlo persistente:

```bash
./scripts/install-systemd-user-slack-bridge.sh
```

Eventos Slack recomendados en la app:
- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

Scopes recomendados:
- Mínimos: `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`
- Avanzados: `commands`, `reactions:write`, `files:write`, `users:read`, `channels:read`, `groups:read`

Capacidades avanzadas habilitadas en el bridge:
- Deduplicación de eventos + reintentos al bridge local.
- Reacciones de estado (⏳ mientras procesa, ✅ ok, ❌ error).
- Fallback a archivo para respuestas largas.
- Slash command configurable (`SLACK_SLASH_COMMAND`, default `/houdi`).

## 7.2 WhatsApp Cloud API (opcional)

Houdi puede recibir mensajes desde WhatsApp Cloud API por webhook y responder por Graph API (proceso separado).

1. Configurar variables en `.env`:
   - `WHATSAPP_VERIFY_TOKEN=...`
   - `WHATSAPP_ACCESS_TOKEN=...`
   - `WHATSAPP_WEBHOOK_PATH=/webhook/whatsapp` (default)
   - `WHATSAPP_APP_SECRET=...` (recomendado para validar firma)
2. Verificar bridge local activo (`HOUDI_LOCAL_API_ENABLED=true`).
3. Levantar bridge WhatsApp:

```bash
npm run whatsapp:bridge
```

Para dejarlo persistente:

```bash
./scripts/install-systemd-user-whatsapp-bridge.sh
```

Configurar en Meta Developers:
- Webhook URL: `https://<tu-dominio>/<WHATSAPP_WEBHOOK_PATH>`
- Verify token: exactamente igual a `WHATSAPP_VERIFY_TOKEN`
- Suscripción de eventos de mensajes entrantes

## 8. Actualización de versión

```bash
cd /ruta/al/repo/houdi-agent
git pull
npm install
npm run build
systemctl restart houdi-agent.service
systemctl status houdi-agent.service --no-pager
```

Si usas servicio de usuario, reemplazar `systemctl` por `systemctl --user`.

## 9. Reglas de publicación segura

- No commitear `.env`.
- No commitear tokens/API keys/refresh tokens.
- Mantener `.env.example` con placeholders.
- Revisar siempre `git status` antes de push.
- Ejecutar `npm run guard:repo` antes de cada push.
- Instalar hook local con `npm run hooks:install`.

## 10. Checklist antes de compartir

1. `npm run build` sin errores.
2. `npm run guard:repo` sin hallazgos.
3. Servicio activo y estable.
4. README actualizado.
5. `docs/RUNBOOK.md` actualizado.
6. Sin secretos en archivos versionados.
