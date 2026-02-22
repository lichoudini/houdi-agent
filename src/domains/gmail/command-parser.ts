export type ParsedKeyValueOptions = {
  args: string[];
  options: Record<string, string>;
};

export type ParsedGmailListArgs =
  | { ok: true; query?: string; limit?: number }
  | { ok: false; error: string };

export type ParsedGmailThreadArgs =
  | { ok: true; threadId: string; limit?: number }
  | { ok: false; error: string };

export type ParsedGmailSendArgs =
  | { ok: true; to: string; subject: string; body: string; cc?: string; bcc?: string; attachments: string[] }
  | { ok: false; error: string };

export type ParsedGmailReplyArgs =
  | { ok: true; messageId: string; body: string; cc?: string; bcc?: string; replyAll: boolean; attachments: string[] }
  | { ok: false; error: string };

export type ParsedGmailForwardArgs =
  | { ok: true; messageId: string; to: string; body: string; cc?: string; bcc?: string; attachments: string[] }
  | { ok: false; error: string };

export type ParsedGmailDraftSubcommand =
  | { ok: true; action: "list"; limit?: number }
  | { ok: true; action: "read"; draftId: string }
  | { ok: true; action: "send"; draftId: string }
  | { ok: true; action: "delete"; draftId: string }
  | { ok: true; action: "create"; to: string; subject: string; body: string; cc?: string; bcc?: string; attachments: string[] }
  | { ok: false; error: string };

export type ParsedRecipientsAddArgs =
  | { ok: true; nameRaw: string; emailRaw: string }
  | { ok: false; error: string };

export type ParsedRecipientsEditArgs =
  | { ok: true; selector: string; nextName?: string; nextEmail?: string }
  | { ok: false; error: string };

const RECIPIENTS_SUBCOMMANDS = new Set(["recipients", "recipient", "destinatarios"]);

function isValidEmailAddress(raw: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(raw.trim());
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("limit inválido. Usa por ejemplo: limit=10");
  }
  return parsed;
}

export function parseAttachmentPaths(raw: string | undefined): string[] {
  const value = raw?.trim() ?? "";
  if (!value) {
    return [];
  }
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isGmailRecipientsSubcommand(subcommand: string): boolean {
  return RECIPIENTS_SUBCOMMANDS.has(subcommand.trim().toLowerCase());
}

export function normalizeGmailRecipientsAction(raw: string): "list" | "add" | "edit" | "delete" | "clear" | "unknown" {
  const action = raw.trim().toLowerCase();
  if (["list", "ls", "status"].includes(action)) {
    return "list";
  }
  if (["add", "new", "create", "alta"].includes(action)) {
    return "add";
  }
  if (["edit", "set", "update", "mod", "modificar"].includes(action)) {
    return "edit";
  }
  if (["del", "delete", "rm", "remove", "baja", "eliminar", "borra"].includes(action)) {
    return "delete";
  }
  if (["clear", "wipe", "reset"].includes(action)) {
    return "clear";
  }
  return "unknown";
}

export function normalizeGmailModifyAction(raw: string): "markread" | "markunread" | "trash" | "untrash" | "star" | "unstar" | null {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "markread" ||
    normalized === "markunread" ||
    normalized === "trash" ||
    normalized === "untrash" ||
    normalized === "star" ||
    normalized === "unstar"
  ) {
    return normalized;
  }
  return null;
}

export function parseGmailListArgs(parsed: ParsedKeyValueOptions): ParsedGmailListArgs {
  try {
    const limit = parsePositiveInt(parsed.options.limit);
    const query = parsed.args.join(" ").trim() || undefined;
    return {
      ok: true,
      ...(query ? { query } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseGmailThreadArgs(parsed: ParsedKeyValueOptions): ParsedGmailThreadArgs {
  const threadId = parsed.args[0]?.trim() ?? "";
  if (!threadId) {
    return { ok: false, error: "Falta threadId." };
  }
  try {
    const limit = parsePositiveInt(parsed.options.limit);
    return {
      ok: true,
      threadId,
      ...(typeof limit === "number" ? { limit } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseGmailSendArgs(parsed: ParsedKeyValueOptions): ParsedGmailSendArgs {
  if (parsed.args.length < 3) {
    return { ok: false, error: "Faltan argumentos para send." };
  }
  const to = parsed.args[0]?.trim() ?? "";
  const subject = parsed.args[1]?.trim() ?? "";
  const body = parsed.args.slice(2).join(" ").trim();
  if (!to || !subject || !body) {
    return { ok: false, error: "Faltan to, subject o body para send." };
  }
  const cc = parsed.options.cc?.trim() || undefined;
  const bcc = parsed.options.bcc?.trim() || undefined;
  const attachments = parseAttachmentPaths(parsed.options.attach || parsed.options.attachments || parsed.options.files);
  return {
    ok: true,
    to,
    subject,
    body,
    attachments,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
  };
}

export function parseGmailReplyArgs(parsed: ParsedKeyValueOptions): ParsedGmailReplyArgs {
  const messageId = parsed.args[0]?.trim() ?? "";
  const body = parsed.args.slice(1).join(" ").trim();
  if (!messageId || !body) {
    return { ok: false, error: "Faltan messageId o body para reply." };
  }
  const cc = parsed.options.cc?.trim() || undefined;
  const bcc = parsed.options.bcc?.trim() || undefined;
  const replyAllRaw = parsed.options.all?.trim().toLowerCase() || parsed.options.replyall?.trim().toLowerCase() || "";
  const replyAll = ["1", "true", "yes", "si", "sí", "on"].includes(replyAllRaw);
  const attachments = parseAttachmentPaths(parsed.options.attach || parsed.options.attachments || parsed.options.files);
  return {
    ok: true,
    messageId,
    body,
    replyAll,
    attachments,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
  };
}

export function parseGmailForwardArgs(parsed: ParsedKeyValueOptions): ParsedGmailForwardArgs {
  if (parsed.args.length < 3) {
    return { ok: false, error: "Faltan argumentos para forward." };
  }
  const messageId = parsed.args[0]?.trim() ?? "";
  const to = parsed.args[1]?.trim() ?? "";
  const body = parsed.args.slice(2).join(" ").trim();
  if (!messageId || !to || !body) {
    return { ok: false, error: "Faltan messageId, to o body para forward." };
  }
  const cc = parsed.options.cc?.trim() || undefined;
  const bcc = parsed.options.bcc?.trim() || undefined;
  const attachments = parseAttachmentPaths(parsed.options.attach || parsed.options.attachments || parsed.options.files);
  return {
    ok: true,
    messageId,
    to,
    body,
    attachments,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
  };
}

export function parseGmailDraftArgs(parsed: ParsedKeyValueOptions): ParsedGmailDraftSubcommand {
  const actionRaw = (parsed.args[0] ?? "list").trim().toLowerCase();
  if (actionRaw === "list") {
    try {
      const limit = parsePositiveInt(parsed.options.limit);
      return {
        ok: true,
        action: "list",
        ...(typeof limit === "number" ? { limit } : {}),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (actionRaw === "read" || actionRaw === "send" || actionRaw === "delete") {
    const draftId = parsed.args[1]?.trim() ?? "";
    if (!draftId) {
      return { ok: false, error: `Falta draftId para ${actionRaw}.` };
    }
    if (actionRaw === "read") {
      return { ok: true, action: "read", draftId };
    }
    if (actionRaw === "send") {
      return { ok: true, action: "send", draftId };
    }
    return { ok: true, action: "delete", draftId };
  }

  if (actionRaw === "create") {
    if (parsed.args.length < 4) {
      return { ok: false, error: "Faltan argumentos para draft create." };
    }
    const to = parsed.args[1]?.trim() ?? "";
    const subject = parsed.args[2]?.trim() ?? "";
    const body = parsed.args.slice(3).join(" ").trim();
    if (!to || !subject || !body) {
      return { ok: false, error: "Faltan to, subject o body para draft create." };
    }
    const cc = parsed.options.cc?.trim() || undefined;
    const bcc = parsed.options.bcc?.trim() || undefined;
    const attachments = parseAttachmentPaths(parsed.options.attach || parsed.options.attachments || parsed.options.files);
    return {
      ok: true,
      action: "create",
      to,
      subject,
      body,
      attachments,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
    };
  }

  return { ok: false, error: `Subcomando draft no reconocido: ${actionRaw}` };
}

export function parseRecipientsAddArgs(parsed: ParsedKeyValueOptions): ParsedRecipientsAddArgs {
  const optionEmail = parsed.options.email?.trim() ?? "";
  const emailRaw = optionEmail || (parsed.args[parsed.args.length - 1] ?? "");
  const nameRaw = parsed.options.name?.trim() || parsed.args.slice(0, optionEmail ? parsed.args.length : -1).join(" ").trim();
  if (!nameRaw || !emailRaw) {
    return { ok: false, error: "Faltan nombre o email." };
  }
  return { ok: true, nameRaw, emailRaw };
}

export function parseRecipientsEditArgs(parsed: ParsedKeyValueOptions): ParsedRecipientsEditArgs {
  const selector = parsed.args[0]?.trim() || parsed.options.id?.trim() || parsed.options.selector?.trim() || "";
  const tailArgs = parsed.args.slice(1);
  let nextName = parsed.options.name?.trim() || "";
  let nextEmail = parsed.options.email?.trim() || "";
  if (!nextName && !nextEmail && tailArgs.length > 0) {
    if (tailArgs.length === 1) {
      if (isValidEmailAddress(tailArgs[0] ?? "")) {
        nextEmail = tailArgs[0] ?? "";
      } else {
        nextName = tailArgs[0] ?? "";
      }
    } else {
      const last = tailArgs[tailArgs.length - 1] ?? "";
      if (isValidEmailAddress(last)) {
        nextEmail = last;
        nextName = tailArgs.slice(0, -1).join(" ");
      } else {
        nextName = tailArgs.join(" ");
      }
    }
  }
  if (!selector || (!nextName && !nextEmail)) {
    return { ok: false, error: "Faltan datos para editar." };
  }
  return {
    ok: true,
    selector,
    ...(nextName ? { nextName } : {}),
    ...(nextEmail ? { nextEmail } : {}),
  };
}

export function parseRecipientsDeleteSelector(parsed: ParsedKeyValueOptions): string {
  return (
    parsed.args.join(" ").trim() ||
    parsed.options.id?.trim() ||
    parsed.options.selector?.trim() ||
    parsed.options.name?.trim() ||
    ""
  );
}
