# AGENTS - Reglas de Push

Estas reglas son obligatorias para cualquier agente humano/IA antes de hacer `push`.

## Checklist mínimo (obligatorio)

1. Ejecutar `npm run guard:repo`.
2. Si hubo cambios de código, ejecutar `npm test`.
3. Confirmar `git status` y verificar que no haya artefactos locales.
4. Recién después, hacer `git push`.

## Criterios de bloqueo (no negociables)

- No subir credenciales ni secretos (tokens, API keys, refresh tokens, secretos OAuth).
- No subir memoria/conversaciones del usuario ni logs de auditoría.
- No subir referencias a `LIM` (el repositorio público debe omitir LIM por completo).
- No subir datasets internos o experimentos temporales.

## Activación de hook local

Para forzar el control automáticamente antes de cada push:

```bash
npm run hooks:install
```

Esto configura `.githooks/pre-push` y ejecuta el guard antes del push.
