import { classifyInteractionMode } from "./interaction-mode.js";

export type RouteLayerContext = {
  normalizedText: string;
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
  indexedListKind?: "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
  hasPendingWorkspaceDelete: boolean;
};

export type RouteLayerDecision = {
  allowed: string[];
  reason: string;
  layers: string[];
  strict: boolean;
  exhausted: boolean;
};

function hasIndexedListReferenceCue(normalizedText: string): boolean {
  if (!normalizedText.trim()) {
    return false;
  }
  if (/\b\d{1,2}[:.]\d{2}\b/.test(normalizedText) || /\b\d{1,2}\s*(am|pm)\b/.test(normalizedText)) {
    return false;
  }
  if (
    /\b(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|ultimo|ultima|penultimo|penultima|anterior|siguiente)\b/.test(
      normalizedText,
    )
  ) {
    return true;
  }
  if (/\b(item|indice|opcion|resultado|archivo|correo|mensaje|noticia)\s+\d{1,3}\b/.test(normalizedText)) {
    return true;
  }
  if (
    /\b(abrir|leer|ver|eliminar|borrar|mover|copiar|enviar|mandar)\s+(?:el\s+)?(\d{1,3}|primero|primera|segundo|segunda|tercero|tercera|ultimo|ultima)\b/.test(
      normalizedText,
    )
  ) {
    return true;
  }
  if (
    /\b(abri|abrime|abrilo|leeme|lee|leelo|mostrame|mostralo|manda|mandalo|enviame|envia|envialo)\s+(?:el\s+|la\s+)?(\d{1,3}|primero|primera|segundo|segunda|tercero|tercera|ultimo|ultima|penultimo|penultima|todos|todas)\b/.test(
      normalizedText,
    )
  ) {
    return true;
  }
  return false;
}

function hasMailCue(normalizedText: string): boolean {
  return /\b(gmail|correo|correos|mail|mails|email|emails|inbox|bandeja)\b/.test(normalizedText);
}

function hasSelfSkillCue(normalizedText: string): boolean {
  const hasSkillNoun = /\b(habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\b/.test(normalizedText);
  if (!hasSkillNoun) {
    return false;
  }
  const hasVerb = /\b(crea|crear|agrega|agregar|suma|sumar|incorpora|incorporar|define|definir|configura|configurar|elimina|eliminar|borra|borrar|lista|listar|muestra|mostrar)\b/.test(
    normalizedText,
  );
  return hasVerb;
}

function hasMailSendCue(normalizedText: string): boolean {
  if (!hasMailCue(normalizedText)) {
    return false;
  }
  return /\b(envi\w*|mand\w*|redact\w*|escrib\w*|respond\w*)\b/.test(normalizedText);
}

function hasScheduledMailCue(normalizedText: string): boolean {
  if (!hasMailCue(normalizedText)) {
    return false;
  }
  const hasScheduleVerb = /\b(programa|programar|agenda|agendar|recorda|recordame|recordarme|recuerda|recuerdame)\b/.test(
    normalizedText,
  );
  const hasTemporalCue =
    /\b(hoy|manana|esta tarde|esta noche|a las|en \d+\s*(minuto|minutos|hora|horas|dia|dias|semana|semanas))\b/.test(normalizedText) ||
    /\b\d{1,2}[:.]\d{2}\b/.test(normalizedText) ||
    /\b\d{1,2}\s*(am|pm)\b/.test(normalizedText);
  return hasScheduleVerb && hasTemporalCue;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function narrow(
  base: string[],
  subset: string[],
  options?: { strict?: boolean },
): { allowed: string[]; exhausted: boolean } {
  const allowed = new Set(subset);
  const next = base.filter((item) => allowed.has(item));
  if (next.length > 0) {
    return { allowed: next, exhausted: false };
  }
  if (options?.strict) {
    return { allowed: [], exhausted: true };
  }
  return { allowed: base, exhausted: false };
}

export function applyIntentRouteLayers(baseCandidates: string[], ctx: RouteLayerContext): RouteLayerDecision | null {
  let allowed = unique(baseCandidates);
  const reasons: string[] = [];
  const layers: string[] = [];
  let strict = false;
  let exhausted = false;
  const interactionMode = classifyInteractionMode(ctx.normalizedText);
  const conversationalOnly = interactionMode === "conversational";
  const listReferenceCue = hasIndexedListReferenceCue(ctx.normalizedText);
  const scheduledMailCue = hasScheduledMailCue(ctx.normalizedText);
  const hasTaskRefCue = /(?:\b|_)tsk(?:[-_][a-z0-9._-]*)?\b/.test(ctx.normalizedText);
  const applyNarrow = (subset: string[], reason: string, layer: string, options?: { strict?: boolean }) => {
    const narrowed = narrow(allowed, subset, options);
    allowed = narrowed.allowed;
    reasons.push(reason);
    layers.push(layer);
    if (options?.strict) {
      strict = true;
    }
    if (narrowed.exhausted) {
      exhausted = true;
    }
  };

  if (ctx.hasPendingWorkspaceDelete) {
    applyNarrow(["workspace"], "confirmación de borrado pendiente", "workspace-delete-confirmation", { strict: true });
  }

  if (ctx.indexedListKind === "gmail-list" && listReferenceCue) {
    applyNarrow(["gmail", "gmail-recipients"], "contexto de lista Gmail", "indexed-list-gmail", { strict: true });
  } else if ((ctx.indexedListKind === "workspace-list" || ctx.indexedListKind === "stored-files") && listReferenceCue) {
    applyNarrow(["workspace", "document"], "contexto de lista workspace", "indexed-list-workspace", { strict: true });
  } else if (ctx.indexedListKind === "web-results" && listReferenceCue) {
    applyNarrow(["web"], "contexto de resultados web", "indexed-list-web", { strict: true });
  }

  if (ctx.hasMailContext && !ctx.hasMemoryRecallCue && !conversationalOnly) {
    if (scheduledMailCue) {
      applyNarrow(["schedule", "gmail", "gmail-recipients"], "mail context programado", "mail-context-schedule", {
        strict: true,
      });
    } else {
      applyNarrow(["gmail", "gmail-recipients"], "mail context", "mail-context", { strict: true });
    }
  }

  if (/\b(recorda|acorda|memoria|memory)\b/.test(ctx.normalizedText)) {
    applyNarrow(["memory"], "señal fuerte de memoria", "memory-cue", { strict: true });
  }

  if (!conversationalOnly && /\b(workspace|archivo|carpeta|renombra|mueve|copia|pega|borra)\b/.test(ctx.normalizedText)) {
    applyNarrow(["workspace", "document"], "señal fuerte de workspace", "workspace-cue", { strict: true });
  }

  if (
    !conversationalOnly &&
    hasTaskRefCue &&
    /\b(elimina|eliminar|borra|borrar|quita|quitar|cancela|cancelar|edita|editar|modifica|modificar|reprograma|reprogramar|mueve|mover|actualiza|actualizar|ver|listar|lista)\b/.test(
      ctx.normalizedText,
    )
  ) {
    applyNarrow(["schedule"], "referencia explícita de tarea tsk", "schedule-taskref-cue", { strict: true });
  }

  if (!conversationalOnly && hasMailCue(ctx.normalizedText)) {
    if (scheduledMailCue) {
      applyNarrow(["schedule", "gmail", "gmail-recipients"], "señal fuerte de gmail programado", "gmail-cue-schedule", {
        strict: true,
      });
    } else {
      applyNarrow(["gmail", "gmail-recipients"], "señal fuerte de gmail", "gmail-cue", { strict: true });
    }
  }

  if (!conversationalOnly && /\b(web|internet|url|link|noticias)\b/.test(ctx.normalizedText) && !hasMailSendCue(ctx.normalizedText)) {
    applyNarrow(["web"], "señal fuerte de web", "web-cue", { strict: true });
  }

  if (hasSelfSkillCue(ctx.normalizedText) && !/\b(workspace|archivo|carpeta|ruta|path|directorio)\b/.test(ctx.normalizedText)) {
    applyNarrow(["self-maintenance"], "señal fuerte de skill", "selfskill-cue", { strict: true });
  }

  if (allowed.length === baseCandidates.length) {
    return null;
  }
  return {
    allowed,
    reason: reasons.join(" + "),
    layers,
    strict,
    exhausted,
  };
}
