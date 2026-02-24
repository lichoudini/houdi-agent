# Repo Publish Guard

Este proyecto usa un guard de publicación para prevenir leaks de información sensible.

## Qué valida

- Ausencia de secretos hardcodeados.
- Ausencia de archivos `.env` reales y backups.
- Ausencia de logs/DB de runtime.
- Ausencia de referencias internas restringidas.
- Ausencia de datasets y experimentos internos en el repo público.

## Comando

```bash
npm run guard:repo
```

## Hook pre-push (recomendado)

```bash
npm run hooks:install
```

Esto configura `core.hooksPath=.githooks` y ejecuta el guard antes de cada `git push`.

## En CI

El workflow `Repo Guard` ejecuta este control en `push` y `pull_request`.
Si el guard falla, el pipeline bloquea merge/push.
