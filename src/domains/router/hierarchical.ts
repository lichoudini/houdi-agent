export type IntentCoarseDomain =
  | "communication"
  | "files"
  | "operations"
  | "planning-memory"
  | "knowledge"
  | "social";

export type HierarchicalIntentDecision = {
  allowed: string[];
  reason: string;
  domains: IntentCoarseDomain[];
  scores: Array<{ domain: IntentCoarseDomain; score: number }>;
  strict: boolean;
  exhausted: boolean;
};

type HierarchicalIntentParams = {
  normalizedText: string;
  candidates: string[];
  hasMailContext: boolean;
  hasMemoryRecallCue: boolean;
  indexedListKind?: "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
  hasPendingWorkspaceDelete: boolean;
  hasRecentConnectorContext?: boolean;
};

const DOMAIN_TO_HANDLERS: Record<IntentCoarseDomain, string[]> = {
  communication: ["gmail", "gmail-recipients"],
  files: ["workspace", "document"],
  operations: ["connector", "self-maintenance"],
  "planning-memory": ["schedule", "memory"],
  knowledge: ["web"],
  social: ["stoic-smalltalk"],
};

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

function scoreDomains(params: HierarchicalIntentParams): Array<{ domain: IntentCoarseDomain; score: number }> {
  const t = params.normalizedText;
  const scores = new Map<IntentCoarseDomain, number>([
    ["communication", 0],
    ["files", 0],
    ["operations", 0],
    ["planning-memory", 0],
    ["knowledge", 0],
    ["social", 0],
  ]);
  const add = (domain: IntentCoarseDomain, value: number) => {
    scores.set(domain, (scores.get(domain) ?? 0) + value);
  };

  if (params.hasMailContext || /\b(gmail|correo|email|mail|inbox|bandeja|destinatario)\b/.test(t)) {
    add("communication", 0.62);
  }
  if (/\b(workspace|archivo|carpeta|pdf|docx|xlsx|csv|json|md|renombr|mover|copiar|pegar|borrar|eliminar|leer archivo)\b/.test(t)) {
    add("files", 0.62);
  }
  if (/\b(web|internet|url|link|noticias|reddit|buscar en)\b/.test(t)) {
    add("knowledge", 0.62);
  }
  if (
    params.hasMemoryRecallCue ||
    /\b(memoria|memory|recorda|recordar|te acordas|te acuerdas|recordatorio|agenda|agendar|tarea|programa|programar)\b/.test(
      t,
    )
  ) {
    add("planning-memory", 0.54);
  }
  if (
    /\b(lim|conector|cloudflared|tunnel|systemctl|servicio|reinicia el agente|actualiza el repositorio|skill)\b/.test(t)
  ) {
    add("operations", 0.68);
  }
  if (/\b(reflexion|estoic|marco aurelio|en que andas|dime algo bonito)\b/.test(t)) {
    add("social", 0.58);
  }

  if (params.indexedListKind === "gmail-list") {
    add("communication", 0.3);
  } else if (params.indexedListKind === "web-results") {
    add("knowledge", 0.3);
  } else if (params.indexedListKind === "workspace-list" || params.indexedListKind === "stored-files") {
    add("files", 0.3);
  }

  if (params.hasPendingWorkspaceDelete) {
    add("files", 0.45);
  }
  if (params.hasRecentConnectorContext && /\b(lim|conector|servicio|tunnel|estado|start|stop|restart)\b/.test(t)) {
    add("operations", 0.35);
  }

  return [...scores.entries()]
    .map(([domain, score]) => ({ domain, score }))
    .sort((a, b) => b.score - a.score);
}

export function buildHierarchicalIntentDecision(params: HierarchicalIntentParams): HierarchicalIntentDecision | null {
  const base = Array.from(new Set(params.candidates));
  if (!params.normalizedText.trim() || base.length === 0) {
    return null;
  }

  const ranked = scoreDomains(params);
  const top = ranked[0];
  if (!top || top.score < 0.45) {
    return null;
  }
  const second = ranked[1];
  const selectedDomains: IntentCoarseDomain[] = [top.domain];
  if (second && second.score >= 0.45 && top.score - second.score <= 0.15) {
    selectedDomains.push(second.domain);
  }
  const allowedByDomain = selectedDomains.flatMap((domain) => DOMAIN_TO_HANDLERS[domain]);
  const strict =
    selectedDomains.length === 1 &&
    (top.score >= 0.62 || params.hasPendingWorkspaceDelete || Boolean(params.indexedListKind));
  const narrowed = narrow(base, allowedByDomain, { strict });
  const allowed = narrowed.allowed;
  if (allowed.length === base.length) {
    return null;
  }
  return {
    allowed,
    domains: selectedDomains,
    scores: ranked.slice(0, 4),
    reason: `hierarchy:${selectedDomains.join("+")}`,
    strict,
    exhausted: narrowed.exhausted,
  };
}
