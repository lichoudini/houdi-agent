function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function extractQuotedSegments(text: string): string[] {
  const pattern = /"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|«([^»\n]+)»/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] || match[2] || match[3] || match[4] || "").trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

export function sanitizeSelfSkillText(text: string): string {
  return truncateInline(text.replace(/\s+/g, " ").trim(), 1200);
}

export function extractSelfSkillInstructionFromText(text: string): string {
  const original = text.trim();
  if (!original) {
    return "";
  }

  const quoted = extractQuotedSegments(original);
  if (quoted.length > 0) {
    const joined = quoted.join(" ").trim();
    if (joined) {
      return sanitizeSelfSkillText(joined);
    }
  }

  const patterns = [
    /\b(?:agrega|agregar|suma|sumar|anade|añade|incorpora|incorporar|crea|crear|genera|generar|define|definir|configura|configurar|habilita|habilitar|entrena|entrenar|ensena|enseña|mejora|mejorate)\s+(?:una?\s+|la\s+|el\s+)?(?:nueva\s+)?(?:habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\s*(?:de|para|que|:|-)?\s*(.+)$/i,
    /\b(?:nueva\s+)?(?:habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\s*[:=-]\s*(.+)$/i,
    /\b(?:mejorate|mejora)\s+(?:con|para)\s+(.+)$/i,
    /\b(?:crear|crea|sumar|suma|agregar|agrega)\s+skill\s+(?:de|para|que|:|-)?\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const extracted = original.match(pattern)?.[1]?.trim();
    if (!extracted) {
      continue;
    }
    const cleaned = extracted
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^(de|para|que|sobre|acerca de)\s+/i, "")
      .trim();
    if (cleaned) {
      return sanitizeSelfSkillText(cleaned);
    }
  }

  return "";
}

export function isSkillDraftMultiMessageRequested(textNormalized: string): boolean {
  return (
    /\b(varios mensajes|en varios mensajes|por partes|en partes|paso a paso|de a poco)\b/.test(textNormalized) &&
    /\b(skill|skills|habilidad|habilidades|regla|reglas|capacidad|capacidades)\b/.test(textNormalized)
  );
}

export function isSkillDraftCommitRequested(textNormalized: string): boolean {
  if (!textNormalized) {
    return false;
  }
  const hasCommitVerb =
    /\b(listo|aplica|aplicalo|aplicar|finaliza|finalizar|termina|terminar|guarda|guardar|confirma|confirmar)\b/.test(
      textNormalized,
    ) || /\bcrea(?:r)?\b/.test(textNormalized);
  if (!hasCommitVerb) {
    return false;
  }
  const hasDraftOrSkillNoun = /\b(borrador|draft|skill|skills|habilidad|habilidades|regla|reglas)\b/.test(
    textNormalized,
  );
  const explicitReadyPhrase =
    /\blisto[, ]+\s*crea(?:r)?\s+(?:la\s+)?(?:habilidad|skill)\b/.test(textNormalized) ||
    /\bcrea(?:r)?\s+(?:la\s+)?(?:habilidad|skill)\b/.test(textNormalized);
  return hasDraftOrSkillNoun || explicitReadyPhrase;
}

export function isSkillDraftCancelRequested(textNormalized: string): boolean {
  return /\b(cancela|cancelar|descarta|descartar|olvida|olvidar|aborta|abortar)\b/.test(textNormalized);
}

export function isSkillDraftShowRequested(textNormalized: string): boolean {
  return (
    /\b(ver|mostrar|mostrame|muestrame|estado|resumen)\b/.test(textNormalized) &&
    /\b(borrador|draft|skill|habilidad)\b/.test(textNormalized)
  );
}

export function isLikelySelfSkillDraftLine(text: string, textNormalized: string): boolean {
  if (!textNormalized) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const explicitSkillCue =
    /\b(skill|skills|habilidad|habilidades|regla|reglas|capacidad|capacidades|comportamiento|comportate|comportarse)\b/.test(
      textNormalized,
    ) ||
    /\b(?:siempre|nunca|evita|usa|responde|prioriza|debe|deberia|tiene que)\b/.test(textNormalized);
  if (explicitSkillCue) {
    return true;
  }

  const structuredDirective =
    /^[-*]\s+/.test(trimmed) ||
    /^\d+[.)]\s+/.test(trimmed) ||
    /\b[a-z_][a-z0-9_ -]{1,30}\s*:\s*.+/i.test(trimmed);
  if (structuredDirective) {
    return true;
  }

  const likelyOtherDomain =
    /\b(envia|enviar|correo|gmail|email|mail|workspace|archivo|carpeta|noticias|web|internet|recordame|recordar|agenda|tarea|lim|conector|reboot|reinicia|actualiza)\b/.test(
      textNormalized,
    );
  if (likelyOtherDomain) {
    return false;
  }

  return trimmed.length >= 18;
}

export function formatSelfSkillDraftLines(lines: string[]): string {
  if (lines.length === 0) {
    return "(vacio)";
  }
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}
