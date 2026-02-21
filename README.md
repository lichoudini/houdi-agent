# Houdi Agent (Telegram + agentes locales)

Proyecto base desde cero para arrancar un asistente de operación de PC por Telegram, con una arquitectura simple que puedas escalar.

## Documentación

- `docs/PROJECT.md`: visión general del proyecto
- `docs/ARCHITECTURE.md`: arquitectura y flujo interno
- `docs/RUNBOOK.md`: operación diaria, rollout y troubleshooting
- `docs/INSTALL.md`: instalación paso a paso en otra PC
- `docs/AGENT_MEMORY_BASELINE.md`: baseline de memoria y personalidad

## Enfoque de seguridad del MVP

- Solo usuarios de Telegram autorizados (`TELEGRAM_ALLOWED_USER_IDS`)
- Ejecución **sin shell** (`spawn`), para reducir inyección
- Permisos por agente (`agents/*.json`) con allowlist de comandos
- Timeout por tarea

Este proyecto puede operar con privilegios altos si así lo configuras.

## Permisos y Responsabilidad

- El perfil actual de agentes puede incluir comandos sensibles (por ejemplo `sudo`, `systemctl`, `shutdown`).
- El operador de la instancia es responsable de dónde se instala, qué usuario lo ejecuta y qué permisos del host concede.
- Para uso público, no compartas tu `.env`, tokens ni credenciales OAuth.
- Recomendado: usar un host dedicado para el agente y una cuenta de Telegram exclusiva para operación.

## Perfiles de Despliegue

Perfil `full-control` (equipo propio y de confianza):

- Objetivo: máxima autonomía operativa.
- Sugerido: `DEFAULT_AGENT=admin`.
- Sugerido: habilitar solo lo que realmente uses (`ENABLE_REBOOT_COMMAND`, `ENABLE_LIM_CONTROL`, `ENABLE_GMAIL_ACCOUNT`).
- Ejecutar en host dedicado y con monitoreo de logs.

Perfil `moderated` (entorno compartido o más estricto):

- Objetivo: minimizar riesgo de ejecución accidental.
- Sugerido: `DEFAULT_AGENT=operator`.
- Sugerido: mantener `ENABLE_REBOOT_COMMAND=false` y `ENABLE_LIM_CONTROL=false` si no son imprescindibles.
- Activar confirmaciones con `/adminmode on` antes de tareas sensibles.
- Reducir allowlists en `agents/operator.json` y reservar `agents/admin.json` para casos puntuales.

## Requisitos

- Node.js 22+
- Un bot token de Telegram (BotFather)
- Tu user ID de Telegram
- (Opcional) API key de OpenAI para `/ask`, chat libre y transcripción de audio

## Configuración

Wizard recomendado (paso a paso por CLI):

```bash
npm run onboard
```

Alias:

```bash
npm run setup
# o:
./scripts/houdi-onboard.sh
```

Si ejecutas onboarding en modo no interactivo parcial, puedes omitir la confirmación inicial de riesgo con:

```bash
npm run onboard -- --accept-risk
```

Configuración manual:

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
- `HOUDI_WORKSPACE_DIR` (default: `./workspace`)
- `HOUDI_CONTEXT_FILE_MAX_CHARS` (default: `3000`)
- `HOUDI_CONTEXT_TOTAL_MAX_CHARS` (default: `15000`)
- `HOUDI_MEMORY_MAX_RESULTS` (default: `6`)
- `HOUDI_MEMORY_SNIPPET_MAX_CHARS` (default: `320`)
- `HOUDI_MEMORY_BACKEND` (`hybrid` o `scan`, default: `hybrid`)
- `HOUDI_SCHEDULE_FILE` (default: `./houdi-schedule.json`)
- `HOUDI_SCHEDULE_POLL_MS` (default: `15000`)
- `HOUDI_INTENT_ROUTER_DATASET_FILE` (default: `./houdi-intent-router-dataset.jsonl`)
- `HOUDI_INTENT_ROUTER_ROUTES_FILE` (default: `./workspace/state/intent-routes.json`)
- `HOUDI_INTENT_ROUTER_CHAT_ROUTES_FILE` (default: `./workspace/state/intent-routes-by-chat.json`)
- `HOUDI_INTENT_ROUTER_CALIBRATION_FILE` (default: `./workspace/state/intent-calibration.json`)
- `HOUDI_INTENT_ROUTER_HYBRID_ALPHA` (default: `0.72`, balance léxico vs char n-gram)
- `HOUDI_INTENT_ROUTER_MIN_SCORE_GAP` (default: `0.03`, brecha mínima entre primer y segundo intent)
- `HOUDI_INTENT_ROUTER_AB_ENABLED` (default: `false`)
- `HOUDI_INTENT_ROUTER_AB_SPLIT_PERCENT` (default: `50`)
- `HOUDI_INTENT_ROUTER_AB_VARIANT_B_ALPHA` (default: `0.66`)
- `HOUDI_INTENT_ROUTER_AB_VARIANT_B_MIN_GAP` (default: `0.02`)
- `HOUDI_INTENT_ROUTER_AB_VARIANT_B_THRESHOLD_SHIFT` (default: `0`)
- `HOUDI_INTENT_ROUTER_ALERT_PRECISION_MIN` (default: `0.55`)
- `HOUDI_INTENT_ROUTER_ALERT_MIN_SAMPLES` (default: `20`)
- `HOUDI_SELFSKILL_DRAFTS_FILE` (default: `./houdi-selfskill-drafts.json`)
- `HOUDI_INTERESTS_FILE` (default: `./houdi-interests.json`)
- `HOUDI_SUGGESTIONS_ENABLED` (default: `true`)
- `HOUDI_SUGGESTIONS_MAX_PER_DAY` (default: `15`)
- `HOUDI_SUGGESTIONS_MIN_INTERVAL_MINUTES` (default: `90`)
- `HOUDI_SUGGESTIONS_MIN_OBSERVATIONS` (default: `10`)
- `HOUDI_SUGGESTIONS_POLL_MS` (default: `600000`)
- `OPENAI_API_KEY` (opcional, necesaria para `/ask`)
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_MAX_OUTPUT_TOKENS` (default: `800`)
- `HOUDI_PROGRESS_NOTICES` (default: `false`, muestra/oculta avisos intermedios con variantes cómicas de estado mientras piensa/carga)
- `OPENAI_AUDIO_MODEL` (default: `whisper-1`)
- `OPENAI_AUDIO_LANGUAGE` (default sugerido: `es`)
- `OPENAI_AUDIO_MAX_FILE_BYTES` (default: `20000000`, 20MB)
- `HOUDI_FILE_MAX_FILE_BYTES` (default: `50000000`, 50MB)
- `HOUDI_IMAGE_MAX_FILE_BYTES` (default: `20000000`, 20MB)
- `HOUDI_DOC_MAX_FILE_BYTES` (default: `25000000`, 25MB)
- `HOUDI_DOC_MAX_TEXT_CHARS` (default: `15000`)
- `ENABLE_WEB_BROWSE` (default: `true`)
- `WEB_SEARCH_MAX_RESULTS` (default: `5`)
- `WEB_FETCH_TIMEOUT_MS` (default: `20000`)
- `WEB_FETCH_MAX_BYTES` (default: `2000000`)
- `WEB_CONTENT_MAX_CHARS` (default: `15000`)
- `ENABLE_GMAIL_ACCOUNT` (default: `false`)
- `GMAIL_CLIENT_ID` (OAuth client ID)
- `GMAIL_CLIENT_SECRET` (OAuth client secret)
- `GMAIL_REFRESH_TOKEN` (refresh token del usuario Gmail)
- `GMAIL_ACCOUNT_EMAIL` (opcional, solo informativo)
- `GMAIL_MAX_RESULTS` (default: `10`)
- `ENABLE_LIM_CONTROL` (default: `false`)
- `LIM_APP_DIR` (default: `./lim-app`)
- `LIM_APP_SERVICE` (default: `houdi-lim-app.service`)
- `LIM_TUNNEL_SERVICE` (default: `houdi-lim-tunnel.service`)
- `LIM_LOCAL_HEALTH_URL` (default: `http://127.0.0.1:3333/health`)
- `LIM_PUBLIC_HEALTH_URL` (default: `http://127.0.0.1:3333/health`)
- `LIM_HEALTH_TIMEOUT_MS` (default: `7000`)
- `LIM_SOURCE_ACCOUNT_MAP_JSON` (opcional, mapeo `fuente -> account`, JSON string)
- `HOUDI_LOCAL_API_ENABLED` (default: `true`, habilita bridge local CLI->bot)
- `HOUDI_LOCAL_API_HOST` (default: `127.0.0.1`)
- `HOUDI_LOCAL_API_PORT` (default: `3210`)
- `HOUDI_LOCAL_API_TOKEN` (opcional, exige `Authorization: Bearer`)
- `ADMIN_APPROVAL_TTL_SECONDS` (default: `300`)
- `AUDIT_LOG_PATH` (default: `./houdi-audit.log`)
- `ENABLE_REBOOT_COMMAND` (default: `false`)
- `REBOOT_COMMAND` (default: `sudo -n /usr/bin/systemctl reboot`)

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
- `/model [show|list|set <modelo>|reset]`
- `/agent`
- `/agent set <nombre>`
- `/ask <pregunta>`
- `/readfile <ruta> [previewChars]`
- `/askfile <ruta> <pregunta>`
- `/mkfile <ruta> [contenido]`
- `/files [limit]`
- `/getfile <ruta|n>`
- `/images [limit]`
- `/workspace ...` (`list`, `mkdir`, `touch`, `write`, `mv`, `rename`, `rm`, `send`)
- `/web <consulta>`
- `/webopen <n|url> [pregunta]`
- `/webask <consulta>`
- `/agenda ...`
- `/gmail ...`
- `/remember <nota>`
- `/memory`
- `/memory search <texto>`
- `/memory view <path> [from] [lines]`
- `/interests [status|add|del|clear|suggest]`
- `/suggest now|status`
- `/selfskill <instrucción>`
- `/selfskill list`
- `/selfskill del <n|last>`
- `/selfskill draft <start|add|show|apply|cancel>`
- `/selfrestart`
- `/selfupdate [check]`
- `/intentstats [n]`
- `/intentfit [n] [iter]`
- `/intentreload`
- `/intentroutes`
- `/intentcalibrate [n]`
- `/intentcurate [n] [apply]`
- `/intentab`
- `/safe on|off|status`
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
Si detecta intención de web (buscar en internet o analizar una URL), lo hace en modo natural sin comandos.
Si detecta intención de recordatorios/tareas con fecha/hora, las agenda en lenguaje natural.
Si activas `/shellmode on`, esos mensajes también podrán disparar ejecución shell (siempre limitada por la allowlist del agente activo).
También puedes enviar nota de voz/audio: el bot lo transcribe y responde sobre ese contenido.
Si envías un archivo por Telegram (document), lo guarda automáticamente en `workspace/files/...`.
Si envías una imagen/foto, la guarda en `workspace/images/...` y además puede analizarla con OpenAI Vision.
También puedes pedir en lenguaje natural operaciones sobre `workspace` (listar, crear carpeta, crear archivo simple, mover, renombrar, eliminar y enviar archivos).

## Seleccion de modelo OpenAI por chat

Ademas del default global por `.env` (`OPENAI_MODEL`), puedes cambiar el modelo en runtime para un chat especifico:

- `/model` o `/model show`: muestra modelo actual del chat, default global y lista sugerida por costo.
- `/model list`: muestra solo la lista sugerida (menor -> mayor costo).
- `/model set <modelo>`: fija override por chat (ej. `gpt-4o-mini`).
- `/model reset`: vuelve al default de `.env`.

Notas:
- El override es en memoria (runtime): no modifica `.env`.
- Aplica a consultas IA de chat, analisis de imagen y planificacion de `/shell`.

## CLI local

Además de Telegram, puedes consultar al agente desde terminal.
Por defecto, la CLI usa `--transport auto`: si detecta bridge local activo, enruta al mismo pipeline natural de Telegram (paridad de funciones de texto).
Si no hay bridge disponible, cae a modo local con OpenAI.

One-shot:

```bash
npm run cli -- agent --message "te acordas de lo que hablamos de gmail"
```

Interactivo:

```bash
npm run cli -- chat
# o:
./scripts/houdi-cli.sh chat
```

Memoria por CLI:

```bash
npm run cli -- memory status
npm run cli -- memory search "LIM"
npm run cli -- memory view memory/2026-02-20.md 1 80
npm run cli -- remember "nota rápida desde CLI"
```

Opciones útiles:

- `--chat-id <n>`: scope de memoria por chat para continuidad.
- `--user-id <n>`: userId lógico para permisos/seguridad.
- `--transport <auto|bridge|local>`: `auto` (default), `bridge` (forzado), `local` (forzado).
- `--json`: salida JSON.
- `--no-memory`: consulta al modelo sin inyectar memoria.
- `--no-remember`: no persistir turnos en memoria.

## Operaciones de Workspace

Comando opcional:

- `/workspace` o `/workspace list [ruta]`
- `/workspace mkdir <ruta>`
- `/workspace touch <ruta> [contenido]`
- `/workspace write <ruta> <contenido>`
- `/workspace mv <origen> <destino>`
- `/workspace rename <origen> <destino>`
- `/workspace rm <ruta>`
- `/workspace send <ruta|n>`
- `/mkfile <ruta> [contenido]`
- `/getfile <ruta|n>`

Modo natural:

- `mostrame que hay en workspace`
- `crea carpeta reportes/2026`
- `mueve "files/chat-123/2026-02-19/reporte.pdf" a "archivados/reporte.pdf"`
- `renombra "archivados/reporte.pdf" a "archivados/reporte-final.pdf"`
- `elimina "archivados/reporte-final.pdf"`
- `crea archivo notas.txt`
- `crea archivo datos.csv con contenido: id,nombre\n1,Ana`
- `crea archivo config.json con contenido: {"modo":"demo"}`
- `enviame "files/chat-123/2026-02-19/reporte.pdf"`
- `enviame el archivo 2`

## Agenda y Recordatorios

Permite crear tareas programadas con lenguaje natural y dispararlas automáticamente en el chat.

Comandos:

- `/agenda` o `/agenda list`
- `/agenda add <cuando> | <detalle>`
- `/agenda del <n|id|last>`
- `/agenda edit <n|id> | <nuevo cuando> | <nuevo detalle opcional>`

Modo natural:

- `recordame mañana a las 10 pagar expensas`
- `programa una tarea para el viernes 15:30 llamar a Juan`
- `crea un recordatorio en 2 horas para tomar agua`
- `lista mis tareas`
- `elimina la tarea 2`
- `edita la tarea 1 para pasado mañana 09:00`

## Auto-Mejora Controlada

Puedes sumar habilidades persistentes sin tocar código fuente manualmente:

- `/selfskill <instrucción>`: guarda una habilidad/regla en `workspace/AGENTS.md` (sección `Dynamic Skills`).
- `/selfskill list`: muestra las últimas habilidades agregadas.
- `/selfskill del <n|last>`: elimina una habilidad por índice (o la última).
- `/selfskill draft ...`: permite construir una habilidad en varios mensajes y aplicarla al final.
- `/selfrestart`: reinicia el servicio del agente (respeta `adminmode` si está activo).
- `/selfupdate [check]`: revisa o aplica actualización a la última versión del repo (`git pull --ff-only`, `npm install` si cambia `package*.json`, `npm run build` y reinicio).

Ejemplos:

- `/selfskill Prioriza responder con formato checklist en tareas operativas`
- `/selfskill Cuando pida "último correo", leer directamente el mensaje más reciente`

Modo natural (sin comandos):

- `agrega la habilidad de responder siempre con pasos concretos`
- `suma la habilidad de confirmar el plan antes de ejecutar cambios`
- `crea la habilidad de mostrar siempre fuente al responder sobre web`
- `crear skill para priorizar respuestas breves y accionables`
- `nueva habilidad: cuando diga "último correo", leer directo el más reciente`
- `quiero crear una skill en varios mensajes`
- `agrega: responde con checklist`
- `agrega: prioriza acciones de alto impacto`
- `listo, crea la habilidad`
- `elimina la habilidad 2`
- `actualizate a la ultima version del repo`
- `reinicia el agente`

## Aprendizaje de Intereses y Sugerencias Proactivas

El agente aprende automaticamente por recurrencia en pedidos de noticias/novedades web y puede sugerir contenido reciente sin que lo pidas.

- Límite duro diario configurable (default: `15` sugerencias por día).
- Intervalo mínimo entre sugerencias configurable.
- Persistente en archivo (`HOUDI_INTERESTS_FILE`) para no perder aprendizaje al reiniciar.

Comandos útiles:

- `/interests`: ver perfil aprendido (observaciones, categorias y keywords top).
- `/interests add <tema>`: agregar interes manual para noticias.
- `/interests del <keyword>`: borrar un interes puntual.
- `/interests clear`: borrar todo el perfil de intereses del chat.
- `/interests suggest`: generar sugerencia inmediata de noticias recientes.
- `/suggest status`: ver cuota/config.
- `/suggest now`: forzar una sugerencia de prueba.

## Integración Gmail (cuenta única)

Permite consultar y operar una cuenta Gmail conectada por OAuth2 (sin requerir Workspace).

Setup mínimo:

1. Crear credenciales OAuth en Google Cloud (Gmail API habilitada).
2. Obtener `refresh_token` del usuario (scope recomendado: `gmail.readonly gmail.send gmail.modify`).
3. Completar en `.env`:
   - `ENABLE_GMAIL_ACCOUNT=true`
   - `GMAIL_CLIENT_ID=...`
   - `GMAIL_CLIENT_SECRET=...`
   - `GMAIL_REFRESH_TOKEN=...`
   - `GMAIL_ACCOUNT_EMAIL=tu_cuenta@gmail.com` (opcional)
4. Reiniciar el bot.

Comandos:

- `/gmail status`
- `/gmail profile`
- `/gmail list [query ...] [limit=10]`
- `/gmail read <messageId>`
- `/gmail send <to> "<subject>" "<body>" [cc=a@x.com,b@y.com] [bcc=z@x.com]`
- `/gmail markread <messageId>`
- `/gmail markunread <messageId>`
- `/gmail trash <messageId>`
- `/gmail untrash <messageId>`
- `/gmail star <messageId>`
- `/gmail unstar <messageId>`
- `/gmail recipients list`
- `/gmail recipients add "<nombre>" <email>`
- `/gmail recipients edit <nombre|n> [name="<nuevo nombre>"] [email=<nuevo@email>]`
- `/gmail recipients del <nombre|n>`
- `/gmail recipients clear`

Modo natural (sin comandos):

- `mostrame los ultimos correos no leídos`
- `lee el correo 2`
- `marcalo como leído`
- `enviá un correo a ana@empresa.com asunto: Reunión cuerpo: Confirmo mañana 10am`
- `agrega destinatario Ana ana@empresa.com`
- `actualiza destinatario Ana ana.nueva@empresa.com`
- `elimina destinatario Ana`
- `decime el estado de gmail`
- `mostrame el perfil de la cuenta gmail conectada`

Nota de seguridad:

- El bot exige que el agente activo tenga `gmail-api` en `allowCommands` (incluido en `admin`).

## Control LIM (natural)

Con `ENABLE_LIM_CONTROL=true`, puedes operar una app externa y su túnel sin comandos:

- `estado de LIM`
- `levantá LIM`
- `reiniciá LIM`
- `apagá LIM`
- `levantá LIM solo app` (sin tunnel)

Regla de activación:

- El dominio LIM solo se activa si el mensaje incluye explícitamente `LIM`/`lim` (o `/lim`).
- Si no aparece `lim`, el bot no entra al flujo LIM (evita confusiones con otras conversaciones).

Consulta directa de mensajes LIM (contacto + fuente):

- `/lim first_name:Juan last_name:Perez fuente:account_demo_c_jack count:3`
- `consulta LIM first_name:Juan last_name:Perez fuente:account_demo_c_jack`
- `revisar LIM de Rodrigo Toscano en linkedin marylin`
- `trae los ultimos 3 mensajes de Rodrigo Toscano en linkedin marylin`

Notas de consulta LIM:

- En lenguaje natural, `count` por defecto es `3` (max `10`).
- La lectura prioriza mensajes del prospecto (entrantes/no propios).
- El parser usa estrategia híbrida (reglas + fallback IA) para extraer `first_name`, `last_name`, `fuente` y reducir errores de interpretación en frases libres.

`fuente` se normaliza a `account`. Si necesitas alias personalizados usa:

```env
LIM_SOURCE_ACCOUNT_MAP_JSON={"linkedin":"linkedin_marylin","linkedin_marylin":"linkedin_marylin","linkedin_martin":"linkedin_martin","account_demo_b":"account_demo_b_marylin","account_demo_b_manuel":"account_demo_b_manuel","account_demo_c":"account_demo_c_jack","account_demo_a":"account_demo_a"}
```

Instalación de servicios `systemd --user` para dejarlo persistente:

```bash
cd /home/houdi/houdi-agent
./scripts/install-lim-user-services.sh
```

El script crea:
- `houdi-lim-app.service`
- `houdi-lim-tunnel.service`
- `houdi-lim-stack.target`

## Navegación Web

Comandos:

- `/web <consulta>`: busca en la web y devuelve resultados numerados.
- `/crypto [consulta] [limit]`: mercado crypto en USD (CoinGecko).
- `/weather [ubicación]`: clima actual + próximos días (Open-Meteo).
- `/reddit <consulta> [limit]`: búsqueda de posts en Reddit API.
- `/webopen <n|url> [pregunta]`: abre un resultado (o URL directa). Si agregas pregunta, lo analiza con IA.
- `/webask <consulta>`: búsqueda + síntesis automática con fuentes.

Ejemplos:

- `/web precio dolar oficial argentina hoy`
- `/webopen 1 resumen en 5 puntos`
- `/webask cambios de Node.js v24`

Modo natural:

- `busca en internet cambios de Node.js v24`
- `busca precio bitcoin hoy`
- `dime noticias interesantes del mundo cripto`
- `contame últimas noticias de política argentina`
- `abre https://nodejs.org/en/blog y resumilo`
- `quiero links sobre ollama en docker`

Para pedidos de noticias en lenguaje natural, el buscador prioriza lo más reciente, muestra como máximo 2 resultados de Reddit y luego completa con otras fuentes web relevantes.

## Lectura de Documentos (PDF + Office)

Comandos:

- `/readfile <ruta> [previewChars]`: extrae texto del archivo y muestra vista previa.
- `/askfile <ruta> <pregunta>`: extrae texto y consulta OpenAI sobre ese documento.

Modo natural:

- Puedes escribir en chat libre o en `/ask` algo como:
`en workspace hay un contrato.pdf, analizalo`
- Si detecta referencia a archivo + intención (leer/analizar/resumir), lo procesa sin comando explícito.

Formatos soportados:

- PDF: `.pdf` (via `pdf-parse`)
- Word: `.docx` (via `mammoth`)
- Hojas de cálculo: `.xls`, `.xlsx`, `.ods` (via `xlsx`)
- Presentaciones: `.pptx`, `.odp` (extracción XML)
- Texto OpenDocument: `.odt`
- Rich text: `.rtf`
- Texto plano: `.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.yml`, `.yaml`, `.xml`, `.html`, `.htm`, etc.

Notas:

- Si la ruta tiene espacios, usa comillas: `/readfile "Documentos/Reporte Q1 2026.pdf"`
- Formatos legacy `.doc` y `.ppt` no están soportados directamente; conviene convertirlos a `.docx`/`.pptx`.
- Por seguridad, solo se leen archivos dentro del directorio del proyecto.

## Memoria + Personalidad

Houdi ahora usa un workspace con archivos de contexto inyectados al prompt:

- `AGENTS.md`: lineamientos operativos
- `SOUL.md`: personalidad y tono
- `USER.md`: perfil y preferencias
- `HEARTBEAT.md`: checklist de heartbeat
- `MEMORY.md`: memoria de largo plazo
- `memory/YYYY-MM-DD.md`: memoria diaria

Comportamiento:

- El bot crea estos archivos automáticamente si faltan.
- Antes de responder, construye contexto con esos archivos (con límites de tamaño).
- Hace recall en memoria (`MEMORY.md` + `memory/*.md`) y pasa snippets relevantes al modelo.
- El recall usa backend híbrido (lexical + semántico + recencia + MMR) con fallback automático a `scan`.
- También inyecta memoria reciente (hoy/ayer) para continuidad aunque no hagas búsqueda explícita.
- Antes de construir contexto para IA, fuerza un flush de continuidad por chat para reducir pérdida en conversaciones largas.
- Guarda automáticamente intercambios de chat (usuario/asistente) en `memory/YYYY-MM-DD.md`.
- Mantiene memoria por chat en `memory/chats/chat-<id>/YYYY-MM-DD.md` y snapshot de continuidad en `memory/chats/chat-<id>/CONTINUITY.md`.
- Puedes guardar notas rápidas con `/remember`.
- En chat libre puedes preguntar: `te acordás de ...`, `recordás ...`, `buscá en memoria sobre ...`.

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

La unidad se instala con `Restart=on-failure` (no `always`) y límites de reinicio para evitar bucles infinitos.
Si necesitas ajustar política:

```bash
sudo RESTART_POLICY=on-failure RESTART_SEC=5 START_LIMIT_INTERVAL=60 START_LIMIT_BURST=5 ./scripts/install-systemd-system-service.sh
```

Para detenerlo sin relanzado:

```bash
sudo systemctl disable --now houdi-agent.service
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

También usa `Restart=on-failure` con límites de reintentos.

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
