# Baseline de Memoria y Personalidad

## Objetivo
Definir los pilares de calidad del agente en tres capas:

1. Memoria persistente en archivos.
2. Personalidad y lineamientos fuera del código.
3. Prompt estructurado por secciones.

## Implementación actual

- `src/agent-context-memory.ts`
  - bootstrap de workspace (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`)
  - carga de contexto con límites por archivo y total
  - recall de memoria (`MEMORY.md` + `memory/*.md`) con ranking híbrido
  - fallback de backend (`hybrid` -> `scan`) para resiliencia
  - flush de continuidad por chat antes de razonar
  - notas diarias (`/remember`) y lectura (`/memory view`)

- `src/openai-client.ts`
  - prompt en secciones:
    - personalidad
    - lineamientos
    - memory recall
    - project context
    - estilo de respuesta
  - aplicado en chat, ask y otras rutas de IA

- `src/index.ts`
  - comandos de memoria: `/remember`, `/memory`, `/memory search`, `/memory view`
  - integración de memoria en flujo natural

## Próximos pasos recomendados

1. Embeddings persistentes opcionales para mejorar recall semántico.
2. Mecanismo explícito de "near-token-limit" para flush más inteligente.
3. Segmentación de memoria por tipo de conversación (privada/grupo/canal).
