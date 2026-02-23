# Release Notes - 2026-02-23

## Resumen

Este release endurece el enrutado por contexto, mejora la operación de comandos para mobile/chat y documenta el modo ECO por chat.

## Cambios funcionales

- Router de intenciones:
  - Mejora de `context-filter` y `route-layers` para referencias indexadas coloquiales (`"abri el 2"`, `"manda el 3"`).
  - Menor riesgo de falsos positivos con horarios (`10:30`, `8pm`) en detección de índices.
  - Nuevos tests de narrowing/contexto para casos conversacionales reales.
- Modelo/modo por chat:
  - Alias `/mode` para la misma interfaz de `/model`.
  - Persistencia de override de modelo por chat en estado runtime.
- ECO mode:
  - Exposición operativa de `/eco on|off|status`.
  - Estado visible en `/status`.
  - Variables de configuración para default y tope de tokens.
- LIM:
  - Soporte explícito de `/lim list [limit:10]` para historial de outputs.
  - Auditoría específica para éxito/falla de listados.
- UX de salida:
  - Formateo "touch-friendly" para IDs (`messageId/threadId/draftId`) y rutas de `workspace` en respuestas de chat.

## Cambios de configuración

- `.env.example`:
  - `OPENAI_ECO_MAX_OUTPUT_TOKENS=120`
  - `HOUDI_ECO_MODE_DEFAULT=true`

## Documentación

- README actualizado con:
  - comando `/mode`,
  - sección de Modo ECO,
  - ejemplos y límites de `/lim list`.
- `docs/PROJECT.md` actualizado con un overview alineado al estado actual del sistema.

## Validación

- `npm test`: OK (99 tests passing).
