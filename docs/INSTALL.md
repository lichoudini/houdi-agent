# Houdi Agent - Instalación en Otra PC

Esta guía deja una instalación reproducible para que cualquier persona pueda correr su propia instancia.

## 1. Requisitos

- Linux con `systemd` (Ubuntu/Debian recomendado).
- Node.js 22+ y `npm`.
- Cuenta de Telegram con bot token.
- User ID de Telegram autorizado.
- (Opcional) clave OpenAI.
- (Opcional) credenciales OAuth de Gmail.

## 2. Clonar proyecto

```bash
git clone <URL_DEL_REPO_PRIVADO> houdi-agent
cd houdi-agent
```

## 3. Instalar dependencias

```bash
npm install
```

## 4. Configurar entorno (wizard recomendado)

```bash
npm run onboard
```

Alias:

```bash
./scripts/houdi-onboard.sh
```

Esto genera/actualiza `.env` con todas las variables necesarias.

## 5. Ejecutar en local (smoke test)

```bash
npm run build
npm start
```

Validar desde Telegram:

1. `/status`
2. `/agent`
3. `hola`
4. `/memory`
5. `/web noticias ia hoy`

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

## 10. Checklist antes de compartir

1. `npm run build` sin errores.
2. Servicio activo y estable.
3. README actualizado.
4. `docs/RUNBOOK.md` actualizado.
5. Sin secretos en archivos versionados.
