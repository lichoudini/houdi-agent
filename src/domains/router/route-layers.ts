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
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function narrow(base: string[], subset: string[]): string[] {
  const allowed = new Set(subset);
  const next = base.filter((item) => allowed.has(item));
  return next.length > 0 ? next : base;
}

export function applyIntentRouteLayers(baseCandidates: string[], ctx: RouteLayerContext): RouteLayerDecision | null {
  let allowed = unique(baseCandidates);
  const reasons: string[] = [];
  const layers: string[] = [];

  if (ctx.hasPendingWorkspaceDelete) {
    allowed = narrow(allowed, ["workspace"]);
    reasons.push("confirmación de borrado pendiente");
    layers.push("workspace-delete-confirmation");
  }

  if (ctx.indexedListKind === "gmail-list") {
    allowed = narrow(allowed, ["gmail", "gmail-recipients"]);
    reasons.push("contexto de lista Gmail");
    layers.push("indexed-list-gmail");
  } else if (ctx.indexedListKind === "workspace-list" || ctx.indexedListKind === "stored-files") {
    allowed = narrow(allowed, ["workspace", "document"]);
    reasons.push("contexto de lista workspace");
    layers.push("indexed-list-workspace");
  } else if (ctx.indexedListKind === "web-results") {
    allowed = narrow(allowed, ["web"]);
    reasons.push("contexto de resultados web");
    layers.push("indexed-list-web");
  }

  if (ctx.hasMailContext && !ctx.hasMemoryRecallCue) {
    allowed = narrow(allowed, ["gmail", "gmail-recipients"]);
    reasons.push("mail context");
    layers.push("mail-context");
  }

  if (/\b(recorda|acorda|memoria|memory)\b/.test(ctx.normalizedText)) {
    allowed = narrow(allowed, ["memory"]);
    reasons.push("señal fuerte de memoria");
    layers.push("memory-cue");
  }

  if (/\b(workspace|archivo|carpeta|renombra|mueve|copia|pega|borra)\b/.test(ctx.normalizedText)) {
    allowed = narrow(allowed, ["workspace", "document"]);
    reasons.push("señal fuerte de workspace");
    layers.push("workspace-cue");
  }

  if (/\b(gmail|correo|mail|inbox|bandeja)\b/.test(ctx.normalizedText)) {
    allowed = narrow(allowed, ["gmail", "gmail-recipients"]);
    reasons.push("señal fuerte de gmail");
    layers.push("gmail-cue");
  }

  if (/\b(web|internet|url|link|reddit|noticias)\b/.test(ctx.normalizedText)) {
    allowed = narrow(allowed, ["web"]);
    reasons.push("señal fuerte de web");
    layers.push("web-cue");
  }

  if (allowed.length === baseCandidates.length) {
    return null;
  }
  return {
    allowed,
    reason: reasons.join(" + "),
    layers,
  };
}
