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

## 5. Validación funcional mínima (Telegram)
1. `/status`
2. `/agent`
3. `/adminmode on`
4. `/exec date` -> debe pedir aprobación
5. `/approve <id>`
6. `/reboot status`

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

## 7. Publicación privada en GitHub
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
