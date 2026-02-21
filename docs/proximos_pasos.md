# Proximos Pasos

## Estado general
El proyecto ya esta en un punto funcional para uso real (onboarding, systemd, runbook, memoria, LIM/Gmail, CLI + Telegram).  
Para elevar robustez y mantenibilidad a nivel produccion, se priorizan las siguientes mejoras.

## Avances ya aplicados (resumen)
- Modularizacion inicial por dominios:
  - `src/domains/gmail/*`
  - `src/domains/workspace/*`
  - `src/domains/router/*`
- Migracion de tareas y destinatarios a SQLite (`scheduled-tasks-sqlite`, `email-recipients-sqlite`).
- Estado operativo adicional en SQLite (`sqlite-state-store`) para contexto/idempotencia.
- Comando `/model` para seleccionar modelo OpenAI por chat (override runtime).

## Prioridad alta
1. Completar modularizacion de `src/index.ts` (todavia centraliza demasiada orquestacion).
- Riesgo actual: alta probabilidad de regresiones y baja mantenibilidad.
- Accion: separar por dominios (`intents`, `workspace`, `gmail`, `lim`, `scheduler`, `router`).

2. Incorporar tests automatizados.
- Riesgo actual: cambios en lenguaje natural pueden romper flujos existentes.
- Accion: tests para parser/intents, confirmaciones, file ops, LIM routing y Gmail compose/send.

3. Crear CI/CD base.
- Riesgo actual: no hay validacion automatica en cada cambio.
- Accion: pipeline con `npm ci`, `npm run build`, tests y validaciones de calidad.

4. Mitigar vulnerabilidades de dependencias.
- Riesgo actual: `npm audit` reporta vulnerabilidades altas (incluyendo `xlsx` y cadena transitiva asociada).
- Accion: actualizar/reemplazar dependencias afectadas y documentar mitigaciones.

5. Migrar estado critico a SQLite.
- Riesgo actual: estados en archivos locales con menor robustez para concurrencia/recuperacion.
- Accion: persistir aprobaciones, tareas, estado conversacional e indices de memoria en DB.

## Prioridad media
6. Mejorar observabilidad operativa.
- Accion: healthcheck dedicado, metricas (latencia, errores, retries, duplicados) y alertas basicas.

7. Fortalecer idempotencia de tareas.
- Accion: `request_id` por mensaje + deduplicacion por chat + locks por operacion sensible.

8. Endurecer perfiles de seguridad para instalaciones publicas.
- Accion: modo seguro por defecto, modo full-control explicito y documentacion de riesgos.

9. Evaluacion continua del routing IA.
- Accion: benchmark offline sobre dataset historico y thresholds por ruta para evitar regresiones.

10. Definir estrategia de soporte multiplataforma.
- Accion: perfil oficial para Windows o declarar Linux-only para la primera release publica.

## Plan sugerido por fases
1. Semana 1: CI + tests minimos + mitigaciones de seguridad.
2. Semana 2: modularizacion de `src/index.ts` sin cambios funcionales.
3. Semana 3: SQLite para estado critico + idempotencia.
4. Semana 4: observabilidad + evaluacion automatica de routing.
