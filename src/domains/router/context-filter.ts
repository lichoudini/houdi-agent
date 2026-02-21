export type RouterContextListKind = "workspace-list" | "stored-files" | "web-results" | "gmail-list";

export type RouterContextFilterDecision = {
  allowed: string[];
  reason: string;
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

function narrowCandidates(base: string[], subset: string[]): string[] {
  const allowedSet = new Set(subset);
  const next = base.filter((candidate) => allowedSet.has(candidate));
  return next.length > 0 ? next : base;
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

  const reasons: string[] = [];
  let allowed = uniqueCandidates(params.candidates);
  const now = Date.now();

  const pendingDelete = deps.getPendingWorkspaceDelete(params.chatId);
  if (pendingDelete && pendingDelete.expiresAtMs > now) {
    if (/^(si|sí|no|confirmo|confirmar|cancelar|cancela)$/i.test(normalized)) {
      allowed = narrowCandidates(allowed, ["workspace"]);
      reasons.push("pending-workspace-delete-confirmation-only");
    } else {
      allowed = narrowCandidates(allowed, ["workspace", "document"]);
      reasons.push("pending-workspace-delete");
    }
  }
  const pendingDeletePath = deps.getPendingWorkspaceDeletePath(params.chatId);
  if (pendingDeletePath && pendingDeletePath.expiresAtMs > now) {
    allowed = narrowCandidates(allowed, ["workspace"]);
    reasons.push("pending-workspace-delete-path");
  }

  const indexedListIntent = deps.parseIndexedListReferenceIntent(params.text);
  const listContext = deps.getIndexedListContext(params.chatId);
  const ordinalReference =
    /\b(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|ultimo|ultima|penultimo|penultima|anterior)\b/.test(
      normalized,
    ) || /\b\d{1,3}\b/.test(normalized);
  const likelyListReference = indexedListIntent.shouldHandle || ordinalReference;
  if (listContext && likelyListReference) {
    if (listContext.kind === "gmail-list") {
      allowed = narrowCandidates(allowed, ["gmail", "gmail-recipients"]);
      reasons.push("indexed-list:gmail");
    } else if (listContext.kind === "web-results") {
      allowed = narrowCandidates(allowed, ["web"]);
      reasons.push("indexed-list:web");
    } else if (listContext.kind === "workspace-list" || listContext.kind === "stored-files") {
      allowed = narrowCandidates(allowed, ["workspace", "document"]);
      reasons.push("indexed-list:workspace");
    }
  }

  const isShortFollowUp = normalized.length <= 120;
  const followUpPronouns = /\b(ese|esa|eso|este|esta|esto|lo|la|el|ultimo|ultima|anterior)\b/.test(normalized);
  if (isShortFollowUp && followUpPronouns) {
    if (deps.getLastGmailResultsCount(params.chatId) > 0 && !/\b(archivo|carpeta|workspace|pdf|documento)\b/.test(normalized)) {
      allowed = narrowCandidates(allowed, ["gmail", "gmail-recipients"]);
      reasons.push("recent-gmail-followup");
    }
    if (
      deps.getLastListedFilesCount(params.chatId) > 0 &&
      /\b(archivo|carpeta|workspace|documento|pdf|txt|csv|json|md|renombr|mover|copiar|pegar|borrar|eliminar|abrir|leer)\b/.test(
        normalized,
      )
    ) {
      allowed = narrowCandidates(allowed, ["workspace", "document"]);
      reasons.push("recent-workspace-followup");
    }
  }

  const hasRecentConnectorContext = deps.getLastConnectorContextAt(params.chatId) + deps.connectorContextTtlMs > now;
  const connectorControlVerb = /\b(inicia|iniciar|arranca|arrancar|enciende|deten|detener|apaga|reinicia|reiniciar|estado|status)\b/.test(
    normalized,
  );
  const explicitLimCue = /\b\/?lim\b/.test(normalized) || /\blim-api\b/.test(normalized);
  const mentionsOtherDomain = /\b(gmail|correo|email|archivo|carpeta|workspace|documento|pdf|internet|web|noticias)\b/.test(
    normalized,
  );
  if (hasRecentConnectorContext && explicitLimCue && connectorControlVerb && !mentionsOtherDomain) {
    allowed = narrowCandidates(allowed, ["connector"]);
    reasons.push("recent-connector-context");
  }

  if (explicitLimCue && !mentionsOtherDomain) {
    allowed = narrowCandidates(allowed, ["connector"]);
    reasons.push("explicit-lim-route");
  }

  if (/\b(gmail|correo|email|mail|inbox|bandeja)\b/.test(normalized) && !/\b(workspace|archivo|carpeta|web|internet|noticias)\b/.test(normalized)) {
    allowed = narrowCandidates(allowed, ["gmail", "gmail-recipients"]);
    reasons.push("explicit-gmail-route");
  }

  if (
    /\b(workspace|archivo|carpeta|renombr|mover|copiar|pegar|borrar|eliminar|abrir|leer)\b/.test(normalized) &&
    !/\b(gmail|correo|mail|email|lim|web|internet|noticias)\b/.test(normalized)
  ) {
    allowed = narrowCandidates(allowed, ["workspace", "document"]);
    reasons.push("explicit-workspace-route");
  }

  if (params.hasMailContext && !params.hasMemoryRecallCue) {
    allowed = narrowCandidates(allowed, ["gmail", "gmail-recipients"]);
    reasons.push("mail-lexical-cue");
  } else if (params.hasMemoryRecallCue) {
    allowed = narrowCandidates(allowed, ["memory", "stoic-smalltalk"]);
    reasons.push("memory-recall-cue");
  }

  const base = uniqueCandidates(params.candidates);
  const changed = allowed.length !== base.length || allowed.some((item, index) => item !== base[index]);
  if (!changed) {
    return null;
  }
  return {
    allowed,
    reason: reasons.join(", "),
  };
}
