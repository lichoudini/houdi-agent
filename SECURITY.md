# Security Policy

Si encuentras una vulnerabilidad en Houdi Agent, repórtala en privado al mantenedor del repositorio.

## Principios operativos

- No expongas el bot a usuarios no autorizados.
- No publiques `.env`, tokens de Telegram, API keys ni credenciales OAuth.
- Antes de push al repositorio, ejecuta `npm run guard:repo`.
- Para enforcement local automático, instala hooks con `npm run hooks:install`.
- Ejecuta el agente en un host dedicado cuando uses perfil `full-control`.
- Mantén `HOUDI_LOCAL_API_HOST=127.0.0.1` salvo que tengas una necesidad explícita de red y controles de firewall.

## Hardening recomendado

1. Usa `DEFAULT_AGENT=operator` para operación diaria.
2. Habilita `adminmode` para acciones sensibles y revisa `/approvals`.
3. Mantén `ENABLE_REBOOT_COMMAND=false` si no lo necesitas.
4. Revisa periódicamente `houdi-audit.log`.
5. Ejecuta `/doctor` luego de cambios de configuración o despliegue.

## Reportes útiles

Incluye:

- impacto y severidad
- pasos de reproducción
- entorno (SO, Node, versión de Houdi)
- mitigación sugerida
