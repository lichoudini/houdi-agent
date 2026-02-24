# Release Notes - 2026-02-24

## Resumen

Este release incorpora soporte IA multi-proveedor (OpenAI, Claude y Gemini), actualiza onboarding/configuración para elegir proveedor en wizard y deja documentación operativa alineada.

## Cambios funcionales

- Capa IA multi-proveedor en `src/openai-client.ts`:
  - Routing por proveedor (`openai|anthropic|gemini`).
  - Selección automática por `AI_PROVIDER` y fallback.
  - Detección por prefijo de modelo (`gpt/o*`, `claude*`, `gemini*`).
- Texto/chat:
  - `/ask`, chat libre y consultas de documentos/web pueden usar OpenAI, Claude o Gemini.
- Visión:
  - Análisis de imágenes habilitado en OpenAI, Claude y Gemini.
- Audio:
  - Transcripción mantenida en OpenAI (requisito explícito en mensajes y docs).
- Planeación shell:
  - `/shell` puede usar el proveedor IA configurado (no queda limitado a OpenAI).

## Cambios de configuración

- Nuevas variables:
  - `AI_PROVIDER` (`auto|openai|anthropic|gemini`)
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
  - `GEMINI_API_KEY`, `GEMINI_MODEL`
- `.env.example` actualizado con defaults de Claude y Gemini.
- Wizard (`npm run onboard`) actualizado:
  - paso de proveedor IA,
  - captura de claves/modelos por proveedor,
  - resumen final con estado de proveedores.

## Cambios de UX y comandos

- `/model` y `/mode`:
  - muestran proveedor detectado para el modelo activo,
  - listan sugerencias por proveedor.
- `/status`:
  - reporta proveedor/modelo IA activo por chat.
- Mensajes de error:
  - pasan de OpenAI-only a mensajes genéricos IA con guidance por proveedor.

## Documentación actualizada

- `README.md`
- `docs/INSTALL.md`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT.md`
- `docs/RUNBOOK.md`

## Validación

- `npm run build`: OK
- `npm test`: OK (147/147)
