export type PendingIntentClarificationLike = {
  question: string;
  originalText: string;
  routeHints: string[];
  preferredRoute?: string;
  preferredAction?: string;
  missing?: string[];
};

function isSimpleConfirmationReply(normalizedText: string): boolean {
  return /^(si|sí|no|ok|dale|listo|cancelar|cancela|confirmar|confirmo|afirmativo|negativo)$/i.test(normalizedText);
}

function hasLikelyPathInClarificationReply(raw: string): boolean {
  if (
    /(^|[\s"'`])(\.?\/?[a-z0-9._-]+\/)*[a-z0-9._-]+\.[a-z0-9]{1,12}([\s"'`]|$)/i.test(raw) ||
    /(^|[\s"'`])(?:\/|\.{0,2}\/)[a-z0-9._/-]*\.{2,}[a-z0-9._/-]*([\s"'`]|$)/i.test(raw) ||
    /(^|[\s"'`])[a-z0-9._-]+\/[a-z0-9._/-]*([\s"'`]|$)/i.test(raw)
  ) {
    return true;
  }
  return false;
}

function hasLikelyTemporalClarificationSignal(raw: string, normalizeIntentText: (text: string) => string): boolean {
  const normalized = normalizeIntentText(raw);
  return (
    /\b(hoy|manana|mañana|pasado manana|pasado mañana|esta tarde|esta noche|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/.test(
      normalized,
    ) ||
    /\b(en\s+\d{1,3}\s*(min|mins|minutos|hora|horas|dias|d[ií]as))\b/i.test(normalized) ||
    /\b(a\s+las?\s+\d{1,2}(?::\d{2})?)\b/i.test(normalized) ||
    /\b\d{1,2}:\d{2}\b/.test(raw)
  );
}

function looksLikeNaturalNameClarification(raw: string): boolean {
  const cleaned = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!cleaned || /[@/\\]/.test(cleaned)) {
    return false;
  }
  const words = cleaned
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length < 1 || words.length > 4) {
    return false;
  }
  return words.every((word) => /^[\p{L}][\p{L}'-]{1,}$/u.test(word));
}

export function sanitizeClarificationOriginalText(
  raw: string,
  truncateInline: (text: string, maxChars: number) => string,
): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^\[intent_clarification_applied\]$/i.test(line) &&
        !/^contexto previo:/i.test(line) &&
        !/^aclaraci[oó]n del usuario:/i.test(line),
    );
  const compact = lines.join(" ").replace(/\s+/g, " ").trim();
  return truncateInline(compact || raw.trim(), 800);
}

export function shouldTreatAsClarificationReply(params: {
  text: string;
  pending: PendingIntentClarificationLike;
  normalizeIntentText: (text: string) => string;
  replyReferenceText?: string;
}): boolean {
  const raw = params.text.trim();
  if (!raw) {
    return false;
  }
  if (raw.startsWith("/")) {
    return false;
  }

  const normalizedRaw = params.normalizeIntentText(raw);
  const replyRef = params.replyReferenceText?.trim() ?? "";
  if (replyRef) {
    const refNormalized = params.normalizeIntentText(replyRef);
    const pendingNormalized = params.normalizeIntentText(params.pending.question);
    if (pendingNormalized && refNormalized.includes(pendingNormalized.slice(0, 40))) {
      return true;
    }
    if (/\b(necesito precision|estoy entre dos intenciones|faltan parametros|necesito referencia de tarea|indica)\b/.test(refNormalized)) {
      return true;
    }
  }

  if (isSimpleConfirmationReply(normalizedRaw)) {
    return true;
  }

  if (
    params.pending.preferredRoute &&
    (normalizedRaw === params.pending.preferredRoute || normalizedRaw.includes(params.pending.preferredRoute))
  ) {
    return true;
  }
  if (params.pending.routeHints.some((route) => normalizedRaw === route || normalizedRaw.includes(route))) {
    return true;
  }

  const missing = new Set((params.pending.missing ?? []).map((item) => params.normalizeIntentText(item)));
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw);
  const hasTaskRef =
    /\btsk[-_#]?[a-z0-9._-]{2,}\b/i.test(raw) ||
    /\b(?:ultima|última|ultimo|último|last)\b/i.test(raw) ||
    /\b(?:tarea|recordatorio)\s*(?:numero|nro|#)?\s*\d{1,3}\b/i.test(raw) ||
    /\b(?:numero|nro|#)\s*\d{1,3}\b/i.test(raw);

  if (missing.has("taskref") && hasTaskRef) {
    return true;
  }
  if ((missing.has("to") || missing.has("email")) && hasEmail) {
    return true;
  }
  if (missing.has("name") && looksLikeNaturalNameClarification(raw)) {
    return true;
  }
  if (
    (missing.has("path") || missing.has("source") || missing.has("target") || missing.has("reference")) &&
    hasLikelyPathInClarificationReply(raw)
  ) {
    return true;
  }
  if (missing.has("dueat") && hasLikelyTemporalClarificationSignal(raw, params.normalizeIntentText)) {
    return true;
  }
  if (missing.has("tasktitle")) {
    const hasUsefulTitleText = normalizedRaw.length >= 4 && !isSimpleConfirmationReply(normalizedRaw);
    if (hasUsefulTitleText) {
      return true;
    }
  }
  if (missing.has("query")) {
    const hasUsefulQuery = normalizedRaw.length >= 4 && !isSimpleConfirmationReply(normalizedRaw);
    if (hasUsefulQuery) {
      return true;
    }
  }
  if (
    missing.has("skillreforindex") &&
    (/\b(?:habilidad|skill)\s*(?:numero|nro|#)?\s*\d{1,3}\b/i.test(raw) ||
      /\bsk[-_][a-z0-9._-]{2,}\b/i.test(raw) ||
      /\b(?:ultima|última|ultimo|último|last)\b/i.test(raw))
  ) {
    return true;
  }
  if ((missing.has("firstname") || missing.has("lastname")) && /\b[\p{L}]{2,}\s+[\p{L}]{2,}\b/u.test(raw)) {
    return true;
  }
  if (missing.has("sourcename") && (/\bfuente\b/i.test(raw) || /\b[a-z0-9]+_[a-z0-9._-]+\b/i.test(raw))) {
    return true;
  }
  if (missing.has("target") && (/\bresultado\s+\d{1,2}\b/i.test(raw) || /\bhttps?:\/\/\S+/i.test(raw))) {
    return true;
  }
  if (missing.size > 0 && /\b(tsk[-_]|workspace|archivo|carpeta|gmail|correo|email|web|connector|memoria|recordatorio|tarea)\b/i.test(raw)) {
    return true;
  }

  return false;
}

export function shouldDropPendingClarificationForFreshIntent(
  text: string,
  normalizeIntentText: (text: string) => string,
): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  if (raw.startsWith("/")) {
    return true;
  }

  const normalized = normalizeIntentText(raw);
  if (normalized.length < 10) {
    return false;
  }
  if (isSimpleConfirmationReply(normalized)) {
    return false;
  }

  const verbs =
    /\b(ver|mostrar|lista|listar|crear|crea|editar|edita|enviar|enviame|buscar|busca|abrir|abre|eliminar|borra|programa|recorda|recordar|ejecuta|revisar|consulta|analiza|resumi|resumir|actualiza|modifica|mueve|renombra)\b/;
  const domains =
    /\b(gmail|correo|email|destinatario|workspace|archivo|carpeta|documento|pdf|tarea|task|tsk|web|url|noticia|memoria|connector|shell|exec|comando|skill|habilidad)\b/;
  return verbs.test(normalized) || domains.test(normalized);
}

export function buildClarificationFollowupText(params: {
  pending: PendingIntentClarificationLike;
  replyText: string;
}): string {
  const hintLines: string[] = [];
  if (params.pending.preferredRoute) {
    hintLines.push(`dominio=${params.pending.preferredRoute}`);
  }
  if (params.pending.preferredAction) {
    hintLines.push(`accion=${params.pending.preferredAction}`);
  }
  if (params.pending.missing && params.pending.missing.length > 0) {
    hintLines.push(`faltantes=${params.pending.missing.join(",")}`);
  }
  if (hintLines.length === 0 && params.pending.routeHints.length > 0) {
    hintLines.push(`candidatos=${params.pending.routeHints.join(",")}`);
  }

  const contextLine =
    hintLines.length > 0
      ? `Contexto previo: ${hintLines.join(" | ")}.`
      : "Contexto previo: se pidió aclaración de intención.";

  return [params.pending.originalText, contextLine, `Aclaración del usuario: ${params.replyText.trim()}`].join("\n");
}
