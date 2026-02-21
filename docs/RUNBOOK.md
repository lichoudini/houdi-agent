# Houdi Agent - Runbook Operativo

## 0. Perfiles de operación
- `full-control` (host propio): `DEFAULT_AGENT=admin`, habilitar solo integraciones necesarias y monitorear `journalctl`.
- `moderated` (host compartido): `DEFAULT_AGENT=operator`, mantener `ENABLE_REBOOT_COMMAND=false`/`ENABLE_LIM_CONTROL=false` salvo necesidad, usar `/adminmode on` para cambios sensibles.

## 1. Arranque normal
```bash
sudo systemctl status houdi-agent.service --no-pager
journalctl -u houdi-agent.service -n 50 --no-pager
```

## 2. Post-reboot check (30s)
```bash
cd /home/houdi/houdi-agent
./scripts/check-post-reboot.sh
```

## 3. Backup de configuración
```bash
cd /home/houdi/houdi-agent
./scripts/export-houdi-config.sh
```
El script crea snapshots en `backups/`.

## 4. Rollout de cambios de código
```bash
cd /home/houdi/houdi-agent
npm run build
sudo systemctl restart houdi-agent.service
sudo systemctl status houdi-agent.service --no-pager
```

Alternativa desde Telegram:

- `/selfupdate check` para ver si hay nueva versión.
- `/selfupdate` para aplicar update in-place (`git pull --ff-only`, `npm install` si cambia `package*.json`, `npm run build` y reinicio).
- Si `adminmode` está activo, requerirá `/approve <id>`.

## 5. Validación funcional mínima (Telegram)
1. `/status`
2. `/doctor`
3. `/usage`
4. `/domains`
5. `/policy`
6. `/agenticcanary status`
7. Probar acción sensible y confirmar con `/confirm <plan_id>`
8. `/outbox status`
9. `/agent`
10. `/adminmode on`
11. `/exec date` -> debe pedir aprobación
12. `/approve <id>`
13. `/reboot status`
14. `/intentroutes`
15. `/intentstats 2000`
16. `/intentcanary status`

## 6. Incidentes frecuentes
- Bot no responde:
  - revisar `systemctl status` y `journalctl`
  - validar token y usuario permitido en `.env`
- Error de reboot por privilegios:
  - revisar `REBOOT_COMMAND` en `.env`
  - validar `sudoers` en `/etc/sudoers.d/houdi-agent-reboot`
  - confirmar `NoNewPrivileges=false` en la unidad systemd
- Doble instancia:
  - verificar procesos de `dist/index.js`
  - mantener solo el servicio de sistema activo
- Canary se desactiva solo:
  - revisar `journalctl -u houdi-agent.service -n 200 --no-pager | rg "canary"`
  - revisar accuracy por ruta con `/intentstats`
  - si corresponde, rollback: `/intentversion rollback <id>`
- Router confunde dominios sensibles:
  - validar dataset reciente (`/intentstats`)
  - ajustar thresholds con `/intentfit`
  - recalibrar `/intentcalibrate`
  - aplicar overrides por ruta en `.env` (`HOUDI_INTENT_ROUTER_ROUTE_ALPHA_OVERRIDES_JSON`)

## 7. Operación del intent-router

Comandos operativos:

- `/intentroutes`: inspección de rutas activas y thresholds
- `/intentstats [n]`: métricas y confusiones
- `/intentfit [n] [iter]`: tuning automático de thresholds
- `/intentcalibrate [n]`: calibración de confianza
- `/intentcurate [n] [apply]`: promoción de utterances desde errores
- `/intentversion [list|save|rollback]`: snapshots y rollback
- `/intentcanary [status|set <id> <pct>|off]`: rollout canary

Workers automáticos en segundo plano:

- hard negatives miner
- canary guard

Ambos se controlan por variables `HOUDI_INTENT_ROUTER_*` en `.env`.

## 8. Publicación privada en GitHub
1. Verificar workspace limpio y build:
   - `git status`
   - `npm run build`
2. Commit:
   - `git add -A`
   - `git commit -m "chore: release houdi-agent"`
3. Crear repo privado (si no existe) en tu usuario.
4. Push:
   - `git remote add origin git@github.com:<usuario>/houdi-agent.git`
   - `git branch -M main`
   - `git push -u origin main`
