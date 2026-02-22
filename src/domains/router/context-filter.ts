import { classifyInteractionMode } from "./interaction-mode.js";

export type RouterContextListKind = "workspace-list" | "stored-files" | "web-results" | "gmail-list";

export type RouterContextFilterDecision = {
  allowed: string[];
  reason: string;
  strict: boolean;
  exhausted: boolean;
};

export type RouterContextFilterDeps = {
  normalizeIntentText: (text: string) => string;
  parseIndexedListReferenceIntent: (text: string) => { shouldHandle: boolean };
  getIndexedListContext: (chatId: number) => { kind: RouterContextListKind } | null;
  getPendingWorkspaceDelete: (chatId: number) => { expiresAtMs: number } | null;
  getPendingWorkspaceDeletePath: (chatId: number) => { expiresAtMs: number } | null;
  getLastGmailResultsCount: (chatId: number) => number;
  getLastListedFilesCount: (chatId: number) => number;
  getLastConnectorContextAt: (chatId: number) => number;
  connectorContextTtlMs: number;
};

function uniqueCandidates(candidates: string[]): string[] {
  return Array.from(new Set(candidates));
}

function hasMailCue(normalizedText: string): boolean {
  return /\b(gmail|correo|correos|mail|mails|email|emails|inbox|bandeja)\b/.test(normalizedText);
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

function hasSelfSkillCue(normalizedText: string): boolean {
  const hasSkillNoun = /\b(habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\b/.test(normalizedText);
  if (!hasSkillNoun) {
    return false;
  }
  return /\b(crea|crear|agrega|agregar|suma|sumar|incorpora|incorporar|define|definir|configura|configurar|elimina|eliminar|borra|borrar|lista|listar|muestra|mostrar)\b/.test(
    normalizedText,
  );
}

function narrowCandidates(
  base: string[],
  subset: string[],
  options?: { strict?: boolean },
): { allowed: string[]; exhausted: boolean } {
  const allowedSet = new Set(subset);
  const next = base.filter((candidate) => allowedSet.has(candidate));
  if (next.length > 0) {
    return { allowed: next, exhausted: false };
  }
  if (options?.strict) {
    return { allowed: [], exhausted: true };
  }
  return { allowed: base, exhausted: false };
}

export function buildIntentRouterContextFilter(
  params: {
    chatId: number;
    text: string;
    candidates: string[];
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
  },
  deps: RouterContextFilterDeps,
): RouterContextFilterDecision | null {
  const normalized = deps.normalizeIntentText(params.text);
  if (!normalized) {
    return null;
  }
  const interactionMode = classifyInteractionMode(normalized);
  const conversationalOnly = interactionMode === "conversational";

  const reasons: string[] = [];
  let allowed = uniqueCandidates(params.candidates);
  let strict = false;
  let exhausted = false;
  const now = Date.now();
  const applyNarrow = (subset: string[], reason: string, options?: { strict?: boolean }) => {
    const narrowed = narrowCandidates(allowed, subset, options);
    allowed = narrowed.allowed;
    reasons.push(reason);
    if (options?.strict) {
      strict = true;
    }
    if (narrowed.exhausted) {
      exhausted = true;
    }
  };

  const pendingDelete = deps.getPendingWorkspaceDelete(params.chatId);
  if (pendingDelete && pendingDelete.expiresAtMs > now) {
    if (/^(si|sí|no|confirmo|confirmar|cancelar|cancela)$/i.test(normalized)) {
      applyNarrow(["workspace"], "pending-workspace-delete-confirmation-only", { strict: true });
    } else {
      applyNarrow(["workspace", "document"], "pending-workspace-delete", { strict: true });
    }
  }
  const pendingDeletePath = deps.getPendingWorkspaceDeletePath(params.chatId);
  if (pendingDeletePath && pendingDeletePath.expiresAtMs > now) {
    applyNarrow(["workspace"], "pending-workspace-delete-path", { strict: true });
  }

  const indexedListIntent = deps.parseIndexedListReferenceIntent(params.text);
  const listContext = deps.getIndexedListContext(params.chatId);
  const scheduledMailCue = hasScheduledMailCue(normalized);
  const ordinalReference =
    /\b(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|ultimo|ultima|penultimo|penultima|anterior)\b/.test(
      normalized,
    );
  const likelyListReference = indexedListIntent.shouldHandle || ordinalReference;
  if (listContext && likelyListReference) {
    if (listContext.kind === "gmail-list") {
      applyNarrow(["gmail", "gmail-recipients"], "indexed-list:gmail", { strict: true });
    } else if (listContext.kind === "web-results") {
      applyNarrow(["web"], "indexed-list:web", { strict: true });
    } else if (listContext.kind === "workspace-list" || listContext.kind === "stored-files") {
      applyNarrow(["workspace", "document"], "indexed-list:workspace", { strict: true });
    }
  }

  const isShortFollowUp = normalized.length <= 120;
  const followUpPronouns = /\b(ese|esa|eso|este|esta|esto|lo|la|el|ultimo|ultima|anterior)\b/.test(normalized);
  if (isShortFollowUp && followUpPronouns) {
    if (deps.getLastGmailResultsCount(params.chatId) > 0 && !/\b(archivo|carpeta|workspace|pdf|documento)\b/.test(normalized)) {
      applyNarrow(["gmail", "gmail-recipients"], "recent-gmail-followup");
    }
    if (
      deps.getLastListedFilesCount(params.chatId) > 0 &&
      /\b(archivo|carpeta|workspace|documento|pdf|txt|csv|json|md|renombr|mover|copiar|pegar|borrar|eliminar|abrir|leer)\b/.test(
        normalized,
      )
    ) {
      applyNarrow(["workspace", "document"], "recent-workspace-followup");
    }
  }

  const hasRecentConnectorContext = deps.getLastConnectorContextAt(params.chatId) + deps.connectorContextTtlMs > now;
  const connectorControlVerb = /\b(inicia|iniciar|arranca|arrancar|enciende|deten|detener|apaga|reinicia|reiniciar|estado|status)\b/.test(
    normalized,
  );
  const explicitLimCue = /\b\/?lim\b/.test(normalized) || /\blim-api\b/.test(normalized);
  const mentionsOtherDomain = /\b(gmail|correo|correos|email|emails|mail|mails|archivo|carpeta|workspace|documento|pdf|internet|web|noticias)\b/.test(
    normalized,
  );
  if (hasRecentConnectorContext && explicitLimCue && connectorControlVerb && !mentionsOtherDomain) {
    applyNarrow(["connector"], "recent-connector-context", { strict: true });
  }

  if (explicitLimCue && !mentionsOtherDomain) {
    applyNarrow(["connector"], "explicit-lim-route", { strict: true });
  }

  if (!conversationalOnly && hasMailCue(normalized) && !/\b(workspace|archivo|carpeta|web|internet|noticias)\b/.test(normalized)) {
    if (scheduledMailCue) {
      applyNarrow(["schedule", "gmail", "gmail-recipients"], "explicit-gmail-schedule-route", { strict: true });
    } else {
      applyNarrow(["gmail", "gmail-recipients"], "explicit-gmail-route", { strict: true });
    }
  }

  if (
    !conversationalOnly &&
    /\b(workspace|archivo|carpeta|renombr|mover|copiar|pegar|borrar|eliminar|abrir|leer)\b/.test(normalized) &&
    !/\b(gmail|correo|correos|mail|mails|email|emails|lim|web|internet|noticias)\b/.test(normalized)
  ) {
    applyNarrow(["workspace", "document"], "explicit-workspace-route", { strict: true });
  }

  if (hasSelfSkillCue(normalized) && !/\b(workspace|archivo|carpeta|ruta|path|directorio)\b/.test(normalized)) {
    applyNarrow(["self-maintenance"], "explicit-selfskill-route", { strict: true });
  }

  if (params.hasMailContext && !params.hasMemoryRecallCue && !conversationalOnly) {
    if (scheduledMailCue) {
      applyNarrow(["schedule", "gmail", "gmail-recipients"], "mail-lexical-cue-scheduled");
    } else {
      applyNarrow(["gmail", "gmail-recipients"], "mail-lexical-cue");
    }
  } else if (params.hasMemoryRecallCue) {
    applyNarrow(["memory", "stoic-smalltalk"], "memory-recall-cue", { strict: true });
  }

  const base = uniqueCandidates(params.candidates);
  const changed = allowed.length !== base.length || allowed.some((item, index) => item !== base[index]);
  if (!changed) {
    return null;
  }
  return {
    allowed,
    reason: reasons.join(", "),
    strict,
    exhausted,
  };
}
