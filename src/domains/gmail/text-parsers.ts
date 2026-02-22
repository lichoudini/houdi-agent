export type GmailTextParsersDeps = {
  normalizeIntentText: (text: string) => string;
  extractQuotedSegments: (text: string) => string[];
  normalizeRecipientName: (text: string) => string;
  truncateInline: (text: string, maxChars: number) => string;
  gmailMaxResults: number;
};

export type ParseGmailLabeledFieldsResult = {
  subject: string;
  body: string;
  cc: string;
  bcc: string;
  hasSubjectLabel: boolean;
  hasBodyLabel: boolean;
};

export function createGmailTextParsers(deps: GmailTextParsersDeps) {
  function extractEmailAddresses(text: string): string[] {
    const matches = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
    const deduped = new Set<string>();
    for (const match of matches) {
      deduped.add(match.trim().toLowerCase());
    }
    return [...deduped];
  }

  function extractRecipientNameFromText(text: string): string {
    const quoted = deps.extractQuotedSegments(text).map((item) => deps.normalizeRecipientName(item)).filter(Boolean);
    if (quoted.length > 0) {
      const candidate = quoted[0] ?? "";
      if (!candidate.includes("@")) {
        return candidate;
      }
    }

    const direct =
      text.match(/\b(?:destinatari[oa]|contacto)\s+(?:llamad[oa]|de nombre)?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ .-]{0,40})/i)?.[1] ??
      text.match(/\b(?:a|para)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ.-]{1,40})\b/i)?.[1] ??
      "";

    const cleaned = deps
      .normalizeRecipientName(direct)
      .replace(/[,:;.!?]+$/g, "")
      .replace(/\b(correo|mail|email|gmail)\b/gi, "")
      .trim();
    const lower = deps.normalizeIntentText(cleaned);
    if (!cleaned || ["mi", "mí", "yo", "vos", "tu", "tú"].includes(lower)) {
      return "";
    }
    return cleaned;
  }

  function parseGmailLabeledFields(text: string): ParseGmailLabeledFieldsResult {
    const pattern = /\b(asunto|subject|titulo|title|cuerpo|mensaje|texto|body|cc|bcc)\s*[:=-]\s*/gi;
    const entries: Array<{ key: string; value: string }> = [];
    const matches: Array<{ key: string; labelIndex: number; valueStart: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const key = (match[1] ?? "").toLowerCase();
      const valueStart = match.index + match[0].length;
      matches.push({ key, labelIndex: match.index, valueStart });
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const valueEnd = next ? next.labelIndex : text.length;
      const rawValue = text.slice(current.valueStart, Math.max(current.valueStart, valueEnd));
      const value = rawValue.replace(/^[\s"'`-]+|[\s"'`]+$/g, "").trim();
      if (!value) {
        continue;
      }
      entries.push({ key: current.key, value });
    }

    const subjectValues = entries
      .filter((entry) => ["asunto", "subject", "titulo", "title"].includes(entry.key))
      .map((entry) => entry.value);
    const bodyValues = entries
      .filter((entry) => ["cuerpo", "mensaje", "texto", "body"].includes(entry.key))
      .map((entry) => entry.value);
    const ccValues = entries.filter((entry) => entry.key === "cc").map((entry) => entry.value);
    const bccValues = entries.filter((entry) => entry.key === "bcc").map((entry) => entry.value);

    return {
      subject: subjectValues.join(" ").trim(),
      body: bodyValues.join("\n\n").trim(),
      cc: ccValues.join(", ").trim(),
      bcc: bccValues.join(", ").trim(),
      hasSubjectLabel: subjectValues.length > 0,
      hasBodyLabel: bodyValues.length > 0,
    };
  }

  function detectGmailDraftRequested(textNormalized: string, hasBodyLabel: boolean): boolean {
    if (hasBodyLabel) {
      return false;
    }

    if (
      /\b(redacta|redactar|escribe|escribir|arma|armar|genera|generar|pensa|pensar|inventa|crear)\b/.test(
        textNormalized,
      ) &&
      /\b(correo|mail|email|mensaje|asunto|cuerpo|texto)\b/.test(textNormalized)
    ) {
      return true;
    }

    if (
      /\b(que\s+(?:lo\s+)?(?:piense|redacte|escriba|arme|genere)\s+(?:el\s+)?(?:agente|bot|houdi))\b/.test(
        textNormalized,
      ) ||
      /\b(redactalo|armalo|escribilo)\s+vos\b/.test(textNormalized) ||
      /\b(que\s+sea\s+tu\s+mensaje|a\s+tu\s+criterio)\b/.test(textNormalized)
    ) {
      return true;
    }

    return /\b(asunto\s+vinculado|listado\s+de\s+las?\s+ultimas?\s+noticias)\b/.test(textNormalized);
  }

  function extractLiteralBodyRequest(text: string): string {
    const candidate =
      text.match(/\bque\s+diga\s*(?::|=)?\s*(.+)$/i)?.[1]?.trim() ??
      text.match(/\b(?:texto|mensaje|cuerpo)\s+(?:exacto|literal)\s*(?::|=)?\s*(.+)$/i)?.[1]?.trim() ??
      "";
    if (!candidate) {
      return "";
    }
    const unquoted = candidate.replace(/^["'`]+|["'`]+$/g, "").trim();
    return deps.truncateInline(unquoted, 10_000);
  }

  function extractNaturalSubjectRequest(text: string): string {
    const candidate =
      text.match(/\b(?:el\s+)?(?:asunto|subject)\s*(?:ser[aá]|es|ser[ií]a)\s*[:=-]\s*(.+)$/i)?.[1]?.trim() ??
      text.match(/\b(?:el\s+)?(?:asunto|subject)\s*(?:ser[aá]|es|ser[ií]a)\s+(.+)$/i)?.[1]?.trim() ??
      "";
    if (!candidate) {
      return "";
    }
    const cleaned = candidate
      .replace(/\b(?:cuerpo|mensaje|texto|body)\s*[:=-].*$/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/[.?!\s]+$/g, "")
      .trim();
    return deps.truncateInline(cleaned, 200);
  }

  function detectCreativeEmailCue(textNormalized: string): boolean {
    const creativeWord =
      /\b(improvis\w*|alegre|creativ\w*|original|invent\w*|bonito|lindo|inspirador|poetico|poético)\b/.test(
        textNormalized,
      );
    const askToWrite =
      /\b(arma\w*|redact\w*|escrib\w*|genera\w*|crea\w*|que\s+contenga|a\s+tu\s+criterio|como\s+quieras)\b/.test(
        textNormalized,
      );
    const songOrPoemRequest =
      /\b(cancion|canción|poema|verso|letra)\b/.test(textNormalized) &&
      /\b(sobre|de|con)\b/.test(textNormalized);
    return (creativeWord && askToWrite) || songOrPoemRequest;
  }

  function buildGmailDraftInstruction(text: string): string {
    return text
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
      .replace(/\bcc\s*[:=-]\s*[^\n]+/gi, " ")
      .replace(/\bbcc\s*[:=-]\s*[^\n]+/gi, " ")
      .replace(
        /\b(envia|enviar|enviame|enviarme|manda|mandar|mandame|mandarme|mandale|escribe|escribir|redacta|redactar|responde|responder|correo|correos|mail|mails|email|emails|gmail|a|para)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  function shouldAvoidLiteralBodyFallback(textNormalized: string): boolean {
    return (
      /\b(reflexion|estoic|poema|poesia|noticias?|nove(?:dad(?:es)?|ades?)|s?ultim[oa]s?|actualidad|titulares?|resumen|recordatorios?)\b/.test(
        textNormalized,
      ) &&
      /\b(correo|mail|email|gmail)\b/.test(textNormalized)
    );
  }

  function parseNaturalLimit(textNormalized: string): number | undefined {
    const byCountWord =
      textNormalized.match(/\b(?:ultimos|ultimas|primeros|primeras|top|hasta|muestra|mostra|trae)\s+(\d{1,2})\b/) ??
      textNormalized.match(/\b(\d{1,2})\s+(?:correos|mails|emails|mensajes)\b/);
    const valueRaw = byCountWord?.[1];
    if (!valueRaw) {
      return undefined;
    }
    const parsed = Number.parseInt(valueRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    const maxAllowed = Math.max(1, Math.min(100, deps.gmailMaxResults));
    return Math.min(maxAllowed, parsed);
  }

  function buildNaturalGmailQuery(text: string, textNormalized: string): string {
    const explicitTokens = text.match(
      /\b(?:is|from|to|subject|after|before|newer_than|older_than|label|category|has):[^\s]+/gi,
    );
    if (explicitTokens && explicitTokens.length > 0) {
      return explicitTokens.join(" ");
    }

    const queryTokens: string[] = [];
    if (/\b(no leidos?|sin leer|unread)\b/.test(textNormalized)) {
      queryTokens.push("is:unread");
    }
    if (/\b(destacados?|con estrella|starred)\b/.test(textNormalized)) {
      queryTokens.push("is:starred");
    }
    if (/\b(hoy|today)\b/.test(textNormalized)) {
      queryTokens.push("newer_than:1d");
    }

    const fromEmail = text.match(/\bde\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i)?.[1];
    if (fromEmail) {
      queryTokens.push(`from:${fromEmail.toLowerCase()}`);
    }

    const subjectText = text.match(/\basunto\s*(?:de|que contenga|contiene)?\s*[:=-]?\s*(.+)$/i)?.[1]?.trim();
    if (subjectText) {
      const cleaned = subjectText.replace(/"/g, "").trim();
      if (cleaned) {
        queryTokens.push(`subject:${cleaned}`);
      }
    }

    return queryTokens.join(" ").trim();
  }

  return {
    extractEmailAddresses,
    extractRecipientNameFromText,
    parseGmailLabeledFields,
    detectGmailDraftRequested,
    extractLiteralBodyRequest,
    extractNaturalSubjectRequest,
    detectCreativeEmailCue,
    buildGmailDraftInstruction,
    shouldAvoidLiteralBodyFallback,
    parseNaturalLimit,
    buildNaturalGmailQuery,
  };
}
