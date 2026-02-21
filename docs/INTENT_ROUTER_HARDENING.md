# Intent Router Hardening

Fecha: 2026-02-21

## Objetivo

Elevar robustez del enrutamiento natural para reducir:

- falsas ejecuciones de dominios sensibles (`gmail`, `workspace`, `connector`, `schedule`)
- ambiguedad en pedidos cortos o multi-intent
- degradacion silenciosa de canary/experimentos sin control

## Pipeline de decision (orden real)

1. `route layers`:
   - pre-filtros por contexto fuerte de dominio
   - archivo: `src/domains/router/layers.ts`
2. filtro jerarquico coarse->fine:
   - dominios macro: `communication`, `files`, `operations`, `planning-memory`, `knowledge`, `social`
   - archivo: `src/domains/router/hierarchical.ts`
3. filtro contextual:
   - pending confirm, referencias indexadas, follow-up corto, pistas explicitas LIM/Gmail/workspace
   - archivo: `src/domains/router/context-filter.ts`
4. router semantico hibrido:
   - lexical cosine + BM25 + char n-grams + negativos por ruta
   - archivo: `src/intent-semantic-router.ts`
5. ensemble:
   - fusiona semantico, AI judge, capas y boosts contextuales
6. abstencion por incertidumbre:
   - pide aclaracion si confianza/gap no son suficientes
7. gating tipado:
   - si faltan parametros obligatorios, devuelve pregunta puntual y no ejecuta
8. ejecucion:
   - single-intent o multi-intent top-N (cuando corresponde)

## Scoring semantico robustecido

El score por ruta combina:

- similitud lexical (TF-IDF cosine)
- score BM25 normalizado (saturado en [0,1])
- similitud por char n-grams
- penalizacion por negativos de ruta
- boosts contextuales

Formula conceptual:

- `lexical = (1 - bm25Lambda) * cosine + bm25Lambda * bm25`
- `hybrid = alpha * lexical + (1 - alpha) * charScore + boost - negativePenalty`

`alpha` es adaptivo por mensaje y puede overridearse por ruta.

## Controles de seguridad en ejecucion

- abstencion automatica si:
  - baja confianza calibrada y gap bajo
  - ambiguedad fuerte en top-2 de ensemble
  - dominio sensible con evidencia insuficiente
- gating de campos requeridos para acciones sensibles:
  - `gmail.send`: `to`, `subject/body` segun accion
  - `workspace`: ruta/selectores/nuevo nombre segun accion
  - `connector(LIM)`: `first_name`, `last_name`, `fuente`
  - `schedule edit/delete`: identificador de tarea
  - `gmail-recipients`: nombre/email segun ABM

## Multi-intent controlado

Se habilita ejecucion secuencial de multiples dominios solo cuando:

- hay conectores linguistico-logicos (`luego`, `despues`, `ademas`, `tambien`)
- top candidatos del ensemble tienen soporte de parser por dominio

Resultado:

- ejecuta cada dominio en secuencia
- devuelve resumen final por paso (`OK/NO`)
- registra outcome en dataset para aprendizaje posterior

## Workers autonomos del router

### 1) Hard negatives miner

- lee dataset reciente
- detecta confusiones (predicho != final)
- agrega negativos por ruta (limite configurable)
- persiste rutas + snapshot de version

Variables:

- `HOUDI_INTENT_ROUTER_HARD_NEGATIVES_ENABLED`
- `HOUDI_INTENT_ROUTER_HARD_NEGATIVES_POLL_MS`
- `HOUDI_INTENT_ROUTER_HARD_NEGATIVES_READ_LIMIT`
- `HOUDI_INTENT_ROUTER_HARD_NEGATIVES_MAX_PER_ROUTE`
- `HOUDI_INTENT_ROUTER_HARD_NEGATIVES_MIN_ADDED`

### 2) Canary guard

- monitorea accuracy del canary sobre muestras reales
- si cae por debajo del umbral por N ciclos consecutivos:
  - desactiva canary automaticamente
  - deja auditoria y warning en logs

Variables:

- `HOUDI_INTENT_ROUTER_CANARY_GUARD_ENABLED`
- `HOUDI_INTENT_ROUTER_CANARY_GUARD_POLL_MS`
- `HOUDI_INTENT_ROUTER_CANARY_GUARD_MIN_SAMPLES`
- `HOUDI_INTENT_ROUTER_CANARY_GUARD_MIN_ACCURACY`
- `HOUDI_INTENT_ROUTER_CANARY_GUARD_BREACHES_TO_DISABLE`

## Dataset enriquecido

`houdi-intent-router-dataset.jsonl` ahora puede incluir:

- `routerLayers`, `routerLayerReason`
- `routerHierarchyDomains`, `routerHierarchyReason`, `routerHierarchyAllowed`
- `routerEnsembleTop`
- `routerTypedExtraction`
- `semanticCalibratedConfidence`, `semanticGap`
- `routerAbVariant`, `routerCanaryVersion`

Esto mejora observabilidad, tuning y trazabilidad de decisiones.

## Operacion diaria (comandos utiles)

- `/intentroutes`: estado efectivo de rutas, thresholds y archivos
- `/intentstats [n]`: precision/recall/confusiones y sugerencias
- `/intentfit [n] [iter]`: ajuste de thresholds con dataset
- `/intentcalibrate [n]`: recalibracion de confianza
- `/intentcurate [n] [apply]`: sugerencias/promocion de utterances
- `/intentversion [list|save|rollback]`: snapshots/rollback rapido
- `/intentcanary [status|set|off]`: control canary por version

## Tuning recomendado inicial

- empezar con defaults y dataset minimo de 500-1000 muestras
- ajustar solo rutas conflictivas con `HOUDI_INTENT_ROUTER_ROUTE_ALPHA_OVERRIDES_JSON`
- ejecutar `/intentfit` y luego `/intentcalibrate` tras cambios grandes
- usar canary (`/intentcanary set`) para validar snapshots antes de full rollout
- revisar `intentstats` y `houdi-audit.log` cada ciclo de ajuste
