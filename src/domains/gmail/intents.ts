export type GmailRecipientNaturalIntent = {
  shouldHandle: boolean;
  action?: "list" | "add" | "update" | "delete";
  name?: string;
  email?: string;
};

export type GmailNaturalIntent = {
  shouldHandle: boolean;
  action?:
    | "status"
    | "profile"
    | "list"
    | "read"
    | "send"
    | "markread"
    | "markunread"
    | "trash"
    | "untrash"
    | "star"
    | "unstar";
  query?: string;
  limit?: number;
  messageId?: string;
  messageIndex?: number;
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  draftRequested?: boolean;
  draftInstruction?: string;
  forceAiByMissingSubject?: boolean;
  autoContentKind?: "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last";
  recipientName?: string;
};

type ParseGmailLabeledFieldsResult = {
  subject: string;
  body: string;
  cc: string;
  bcc: string;
  hasSubjectLabel: boolean;
  hasBodyLabel: boolean;
};

export type GmailIntentDeps = {
  normalizeIntentText: (text: string) => string;
  extractQuotedSegments: (text: string) => string[];
  extractEmailAddresses: (text: string) => string[];
  extractRecipientNameFromText: (text: string) => string;
  inferDefaultSelfEmailRecipient: (text: string) => string;
  detectGmailAutoContentKind: (
    textNormalized: string,
  ) => "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last" | undefined;
  parseGmailLabeledFields: (text: string) => ParseGmailLabeledFieldsResult;
  extractLiteralBodyRequest: (text: string) => string;
  extractNaturalSubjectRequest: (text: string) => string;
  detectCreativeEmailCue: (textNormalized: string) => boolean;
  detectGmailDraftRequested: (textNormalized: string, hasBodyLabel: boolean) => boolean;
  buildGmailDraftInstruction: (text: string) => string;
  shouldAvoidLiteralBodyFallback: (textNormalized: string) => boolean;
  parseNaturalLimit: (textNormalized: string) => number | undefined;
  buildNaturalGmailQuery: (text: string, textNormalized: string) => string;
  gmailAccountEmail?: string;
};

export function detectGmailRecipientNaturalIntent(text: string, deps: GmailIntentDeps): GmailRecipientNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }
  const normalized = deps.normalizeIntentText(original);
  const hasRecipientNoun = /\b(destinatari[oa]s?|contactos?|agenda\s+de\s+correo|agenda\s+de\s+email)\b/.test(normalized);
  if (!hasRecipientNoun) {
    return { shouldHandle: false };
  }

  const email = deps.extractEmailAddresses(original)[0] ?? "";
  const name = deps.extractRecipientNameFromText(original);

  if (/\b(lista|listar|mostra|mostrar|ver)\b/.test(normalized)) {
    return { shouldHandle: true, action: "list" };
  }
  if (/\b(elimina|eliminar|borra|borrar|quita|quitar)\b/.test(normalized)) {
    return { shouldHandle: true, action: "delete", ...(name ? { name } : {}) };
  }
  if (/\b(actualiza|actualizar|edita|editar|modifica|modificar|cambia|cambiar)\b/.test(normalized)) {
    return {
      shouldHandle: true,
      action: "update",
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    };
  }
  if (/\b(agrega|agregar|anade|añade|crea|crear|guarda|guardar|registra|registrar)\b/.test(normalized)) {
    return {
      shouldHandle: true,
      action: "add",
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    };
  }

  if (email && name) {
    return { shouldHandle: true, action: "add", name, email };
  }
  return { shouldHandle: false };
}

export function detectGmailNaturalIntent(text: string, deps: GmailIntentDeps): GmailNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = deps.normalizeIntentText(original);
  const emailCandidates = deps.extractEmailAddresses(original);
  const quotedSegments = deps.extractQuotedSegments(original);

  const hasMailContext = /\b(correo|correos|mail|mails|email|emails|gmail|inbox|bandeja)\b/.test(normalized);
  const sendVerb = /\b(envi\w*|mand\w*|escrib\w*|redact\w*|respond\w*)\b/.test(normalized);
  const implicitSelfMailRequest =
    ((/\b(enviame|enviarme|mandame|mandarme|enviarlo|enviarla|mandarlo|mandarla)\b/.test(normalized) &&
      /\b(correo|mail|email|gmail)\b/.test(normalized)) ||
      /\b(enviame|enviarme|mandame|mandarme)\b/.test(normalized)) &&
    /\b(poema|poesia|noticias?|news|recordatorios?|tareas?\s+pendientes?|correo|mail|email|gmail)\b/.test(normalized);
  const readVerb = /\b(lee|leer|abre|abrir|mostra|mostrar|detalle|contenido|revisa|revisar)\b/.test(normalized);
  const listVerb = /\b(lista|listar|mostra|mostrar|dame|trae|consulta|consultar|ver|revisa|revisar)\b/.test(normalized);
  const statusVerb = /\b(estado|status|configurad|configuracion|habilitad|enabled|disabled|deshabilitad)\b/.test(normalized);
  const profileVerb =
    /\b(perfil|profile)\b/.test(normalized) ||
    /\b(que cuenta|qué cuenta|cuenta conectada|correo conectado|email conectado|mail conectado|cuenta actual)\b/.test(
      normalized,
    );

  const markReadVerb = /\b(marca|marcar|pone|poner)\b.*\b(leido|leida|read)\b/.test(normalized);
  const markUnreadVerb = /\b(marca|marcar|pone|poner)\b.*\b(no leido|no leida|unread)\b/.test(normalized);
  const trashVerb = /\b(borra|borrar|elimina|eliminar|papelera|trash)\b/.test(normalized);
  const untrashVerb = /\b(restaura|recupera|saca)\b.*\b(papelera|trash)\b|\buntrash\b/.test(normalized);
  const starVerb = /\b(destaca|destacar|estrella|star)\b/.test(normalized);
  const unstarVerb = /\b(quita|quitar|saca|sacar)\b.*\b(estrella|star)\b|\bunstar\b/.test(normalized);

  const directMessageId = original.match(/\b[0-9a-f]{12,}\b/i)?.[0];
  const indexedRef =
    normalized.match(/\b(?:correo|mail|email|mensaje|resultado)\s*(?:numero|nro|#)?\s*(\d{1,2})\b/)?.[1] ??
    normalized.match(/\b(?:nro|numero|#)\s*(\d{1,2})\b/)?.[1];
  const ordinalMap: Record<string, number> = {
    primero: 1,
    primera: 1,
    segundo: 2,
    segunda: 2,
    tercero: 3,
    tercera: 3,
    cuarto: 4,
    cuarta: 4,
    quinto: 5,
    quinta: 5,
  };
  const ordinalEntry = Object.entries(ordinalMap).find(([word]) => normalized.includes(word));
  const ordinalIndex = ordinalEntry?.[1];
  const wantsLast = /\b(ultimo|ultima|reciente|ese|ese correo|ese mail|el ultimo)\b/.test(normalized);
  const explicitLatestMailPhrase = /\b(?:el\s+)?ultim[oa]\s+(?:correo|mail|email|mensaje)\b/.test(normalized);
  const messageIndex = indexedRef
    ? Number.parseInt(indexedRef, 10)
    : ordinalIndex
      ? ordinalIndex
      : wantsLast
        ? -1
        : undefined;
  const inboxCheckVerb = /\b(revisa|revisar|chequea|chequear|checkea|checkear|mira|mirar|verifica|verificar)\b/.test(
    normalized,
  );

  if (hasMailContext && statusVerb) {
    return { shouldHandle: true, action: "status" };
  }
  if (hasMailContext && profileVerb) {
    return { shouldHandle: true, action: "profile" };
  }

  if (sendVerb && (hasMailContext || emailCandidates.length > 0 || implicitSelfMailRequest)) {
    const inferredSelfTo = deps.inferDefaultSelfEmailRecipient(original);
    const autoContentKind = deps.detectGmailAutoContentKind(normalized);
    const recipientName = deps.extractRecipientNameFromText(original);
    const to =
      emailCandidates[0] ||
      inferredSelfTo ||
      (autoContentKind ? deps.gmailAccountEmail?.trim().toLowerCase() ?? "" : "");

    let subject = "";
    let body = "";
    let cc = "";
    let bcc = "";
    let draftInstruction = "";
    const explicitLiteralBody = deps.extractLiteralBodyRequest(original);
    const explicitNaturalSubject = deps.extractNaturalSubjectRequest(original);
    const creativeCue = deps.detectCreativeEmailCue(normalized);

    if (quotedSegments.length >= 2) {
      subject = quotedSegments[0] ?? "";
      body = quotedSegments.slice(1).join("\n\n").trim();
    } else {
      const labeled = deps.parseGmailLabeledFields(original);
      subject = labeled.subject;
      body = labeled.body;
      cc = labeled.cc;
      bcc = labeled.bcc;
      if (!body && explicitLiteralBody) {
        body = explicitLiteralBody;
      }

      const draftRequested = !explicitLiteralBody && (creativeCue || deps.detectGmailDraftRequested(normalized, labeled.hasBodyLabel));
      if (draftRequested) {
        draftInstruction = deps.buildGmailDraftInstruction(original);
      }
      if (!body && !draftRequested && !explicitLiteralBody && !autoContentKind && !deps.shouldAvoidLiteralBodyFallback(normalized)) {
        body = deps.buildGmailDraftInstruction(original);
      }
    }

    if (!draftInstruction && !body && !explicitLiteralBody && quotedSegments.length < 2 && (creativeCue || deps.detectGmailDraftRequested(normalized, false))) {
      draftInstruction = deps.buildGmailDraftInstruction(original) || original.trim();
    }
    if (!subject && explicitNaturalSubject) {
      subject = explicitNaturalSubject;
    }
    const subjectWasExplicit = Boolean(subject.trim());
    const forceAiDraftByMissingSubject = !subjectWasExplicit && !autoContentKind;
    if (forceAiDraftByMissingSubject) {
      draftInstruction = deps.buildGmailDraftInstruction(original) || original.trim();
      body = "";
    }
    if (!subject) {
      subject = "Mensaje desde Houdi Agent";
    }
    if (!body) {
      body = "Mensaje enviado desde Houdi Agent.";
    }

    if (!cc) {
      cc = original.match(/\bcc\s*[:=]\s*([^\n]+)$/i)?.[1]?.trim() ?? "";
    }
    if (!bcc) {
      bcc = original.match(/\bbcc\s*[:=]\s*([^\n]+)$/i)?.[1]?.trim() ?? "";
    }

    return {
      shouldHandle: true,
      action: "send",
      to,
      subject,
      body,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      draftRequested: Boolean(draftInstruction),
      ...(draftInstruction ? { draftInstruction } : {}),
      ...(forceAiDraftByMissingSubject ? { forceAiByMissingSubject: true } : {}),
      ...(autoContentKind ? { autoContentKind } : {}),
      ...(!emailCandidates[0] && recipientName ? { recipientName } : {}),
    };
  }

  if (hasMailContext && inboxCheckVerb && !directMessageId && typeof messageIndex !== "number") {
    return {
      shouldHandle: true,
      action: "list",
      query: deps.buildNaturalGmailQuery(original, normalized),
      limit: deps.parseNaturalLimit(normalized),
    };
  }

  if (markUnreadVerb && (hasMailContext || directMessageId || messageIndex)) {
    return { shouldHandle: true, action: "markunread", messageId: directMessageId, messageIndex };
  }
  if (markReadVerb && (hasMailContext || directMessageId || messageIndex)) {
    return { shouldHandle: true, action: "markread", messageId: directMessageId, messageIndex };
  }
  if (untrashVerb && (hasMailContext || directMessageId || messageIndex)) {
    return { shouldHandle: true, action: "untrash", messageId: directMessageId, messageIndex };
  }
  if (trashVerb && (hasMailContext || directMessageId || messageIndex)) {
    return { shouldHandle: true, action: "trash", messageId: directMessageId, messageIndex };
  }
  if (unstarVerb && (hasMailContext || directMessageId || messageIndex)) {
    return { shouldHandle: true, action: "unstar", messageId: directMessageId, messageIndex };
  }
  if (starVerb && (hasMailContext || directMessageId || messageIndex)) {
    return { shouldHandle: true, action: "star", messageId: directMessageId, messageIndex };
  }

  if (readVerb && (hasMailContext || directMessageId || messageIndex || explicitLatestMailPhrase)) {
    if (!directMessageId && typeof messageIndex !== "number" && hasMailContext && !explicitLatestMailPhrase) {
      return {
        shouldHandle: true,
        action: "list",
        query: deps.buildNaturalGmailQuery(original, normalized),
        limit: deps.parseNaturalLimit(normalized),
      };
    }
    if (typeof messageIndex === "number") {
      return {
        shouldHandle: true,
        action: "read",
        messageId: directMessageId,
        messageIndex,
      };
    }
    return { shouldHandle: true, action: "read", messageId: directMessageId };
  }

  if (hasMailContext && explicitLatestMailPhrase) {
    return { shouldHandle: true, action: "read", messageId: directMessageId, messageIndex: -1 };
  }

  if (listVerb && hasMailContext) {
    return {
      shouldHandle: true,
      action: "list",
      query: deps.buildNaturalGmailQuery(original, normalized),
      limit: deps.parseNaturalLimit(normalized),
    };
  }

  if (hasMailContext && /\b(no leidos?|sin leer|inbox|bandeja|ultimos|ultimas|recientes)\b/.test(normalized)) {
    return {
      shouldHandle: true,
      action: "list",
      query: deps.buildNaturalGmailQuery(original, normalized),
      limit: deps.parseNaturalLimit(normalized),
    };
  }

  return { shouldHandle: false };
}
