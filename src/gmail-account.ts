import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve as resolvePath } from "node:path";
import { google, type gmail_v1 } from "googleapis";

export type GmailAccountOptions = {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accountEmail?: string;
  maxResults: number;
};

export type GmailAccountStatus = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  accountEmail?: string;
  maxResults: number;
};

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
};

export type GmailMessageAttachment = {
  filename: string;
  mimeType: string;
  size: number;
};

export type GmailMessageDetail = GmailMessageSummary & {
  bodyText: string;
  bodyHtml: string;
  historyId: string;
  internalDate: string;
  attachments: GmailMessageAttachment[];
};

export type GmailDraftSummary = {
  id: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  from: string;
  snippet: string;
  date: string;
};

export type GmailDraftDetail = GmailDraftSummary & {
  bodyText: string;
  bodyHtml: string;
  attachments: GmailMessageAttachment[];
};

export type GmailAttachmentInput = {
  path: string;
  filename?: string;
  contentType?: string;
};

const MAX_SUBJECT_CHARS = 400;
const MAX_BODY_CHARS = 100_000;
const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
const OAUTH_ACCESS_TOKEN_REFRESH_INTERVAL_MS = 4 * 60 * 1000;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeWhitespace(raw: string): string {
  return raw.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = " [...truncado]";
  const usable = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, usable)}${marker}`;
}

function decodeBase64Url(raw: string): string {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function isValidEmailAddress(raw: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(raw.trim());
}

function normalizeEmailToken(raw: string): string {
  return raw.trim().replace(/^["'<]+|[>"']+$/g, "").trim().toLowerCase();
}

function normalizeAddressList(value: string | undefined, label: "to" | "cc" | "bcc"): string | undefined {
  if (!value) {
    return undefined;
  }
  const tokens = value
    .split(",")
    .map((token) => normalizeEmailToken(token))
    .filter(Boolean);
  const unique = Array.from(new Set(tokens));
  if (unique.length === 0) {
    return undefined;
  }
  const invalid = unique.find((email) => !isValidEmailAddress(email));
  if (invalid) {
    throw new Error(`${label} inválido: ${invalid}`);
  }
  return unique.join(", ");
}

function requireNonEmptyMessageId(raw: string, label = "messageId"): string {
  const id = raw.trim();
  if (!id) {
    throw new Error(`${label} vacío`);
  }
  return id;
}

function isMetadataScopeFullFormatError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) {
    return false;
  }
  return /metadata scope/i.test(message) && /format/i.test(message) && /full/i.test(message);
}

function stripHtmlToText(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " "),
  );
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const target = name.toLowerCase();
  const item = headers?.find((header) => (header.name ?? "").toLowerCase() === target);
  return (item?.value ?? "").trim();
}

function collectMessageBodies(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: { plain: string[]; html: string[] },
): void {
  if (!part) {
    return;
  }

  const mime = (part.mimeType ?? "").toLowerCase();
  const data = part.body?.data;
  if (data) {
    const decoded = normalizeWhitespace(decodeBase64Url(data));
    if (decoded) {
      if (mime.startsWith("text/plain")) {
        out.plain.push(decoded);
      } else if (mime.startsWith("text/html")) {
        out.html.push(decoded);
      }
    }
  }

  for (const child of part.parts ?? []) {
    collectMessageBodies(child, out);
  }
}

function collectAttachments(part: gmail_v1.Schema$MessagePart | undefined, out: GmailMessageAttachment[]): void {
  if (!part) {
    return;
  }

  const filename = (part.filename ?? "").trim();
  const size = part.body?.size ?? 0;
  const mimeType = (part.mimeType ?? "application/octet-stream").trim();
  const hasAttachmentBody = Boolean(part.body?.attachmentId || part.body?.data);
  if (filename && hasAttachmentBody) {
    out.push({ filename, mimeType, size });
  }

  for (const child of part.parts ?? []) {
    collectAttachments(child, out);
  }
}

function encodeMimeHeaderUtf8(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value;
  }
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

function toBase64Lines(buffer: Buffer, lineSize = 76): string {
  const base64 = buffer.toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += lineSize) {
    chunks.push(base64.slice(i, i + lineSize));
  }
  return chunks.join("\r\n");
}

function normalizeSubject(raw: string): string {
  const subject = raw.trim();
  if (!subject) {
    throw new Error("subject vacío");
  }
  if (subject.length > MAX_SUBJECT_CHARS) {
    throw new Error(`subject demasiado largo (máximo ${MAX_SUBJECT_CHARS} caracteres)`);
  }
  return subject;
}

function normalizeBody(raw: string): string {
  const body = raw.trim();
  if (!body) {
    throw new Error("body vacío");
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(`body demasiado largo (máximo ${MAX_BODY_CHARS} caracteres)`);
  }
  return body;
}

function normalizeAddressToSend(raw: string): string {
  const to = normalizeAddressList(raw, "to");
  if (!to) {
    throw new Error("to vacío");
  }
  return to;
}

function ensurePrefixedSubject(subject: string, prefix: string): string {
  const trimmed = subject.trim();
  if (!trimmed) {
    return prefix;
  }
  if (new RegExp(`^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "i").test(trimmed)) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}

function sanitizeFilename(raw: string): string {
  return raw.replace(/[\r\n"]/g, "_").trim() || "attachment.bin";
}

function guessContentType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".xml":
      return "application/xml";
    case ".zip":
      return "application/zip";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

function normalizeSearchQuery(query?: string): string | undefined {
  if (!query) {
    return undefined;
  }
  return query
    .replace(/\bhas\s+attachments\b/gi, "has:attachment")
    .replace(/\bis\s+unread\b/gi, "is:unread")
    .replace(/\bis\s+read\b/gi, "is:read")
    .trim();
}

type MimeAttachment = {
  filename: string;
  contentType: string;
  data: Buffer;
};

export class GmailAccountService {
  private readonly enabled: boolean;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly accountEmail?: string;
  private readonly maxResults: number;
  private gmailClient: gmail_v1.Gmail | null = null;
  private gmailClientReadyAtMs = 0;

  constructor(options: GmailAccountOptions) {
    this.enabled = options.enabled;
    this.clientId = options.clientId?.trim() || undefined;
    this.clientSecret = options.clientSecret?.trim() || undefined;
    this.refreshToken = options.refreshToken?.trim() || undefined;
    this.accountEmail = options.accountEmail?.trim() || undefined;
    this.maxResults = clampInt(options.maxResults, 1, 100);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isConfigured(): boolean {
    return this.getStatus().configured;
  }

  getStatus(): GmailAccountStatus {
    if (!this.enabled) {
      return {
        enabled: false,
        configured: false,
        missing: [],
        accountEmail: this.accountEmail,
        maxResults: this.maxResults,
      };
    }

    const missing: string[] = [];
    if (!this.clientId) {
      missing.push("GMAIL_CLIENT_ID");
    }
    if (!this.clientSecret) {
      missing.push("GMAIL_CLIENT_SECRET");
    }
    if (!this.refreshToken) {
      missing.push("GMAIL_REFRESH_TOKEN");
    }

    return {
      enabled: this.enabled,
      configured: missing.length === 0,
      missing,
      accountEmail: this.accountEmail,
      maxResults: this.maxResults,
    };
  }

  private resolveLimit(value?: number): number {
    return clampInt(value ?? this.maxResults, 1, 100);
  }

  private async getGmailClient() {
    if (!this.enabled) {
      throw new Error("Gmail account está deshabilitado (ENABLE_GMAIL_ACCOUNT=false)");
    }
    const status = this.getStatus();
    if (!status.configured) {
      throw new Error(`Gmail account no configurado: faltan ${status.missing.join(", ")}`);
    }

    const now = Date.now();
    if (this.gmailClient && now - this.gmailClientReadyAtMs <= OAUTH_ACCESS_TOKEN_REFRESH_INTERVAL_MS) {
      return this.gmailClient;
    }
    const oauth2 = new google.auth.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
    oauth2.setCredentials({
      refresh_token: this.refreshToken,
    });

    await oauth2.getAccessToken();

    const client = google.gmail({
      version: "v1",
      auth: oauth2,
    });
    this.gmailClient = client;
    this.gmailClientReadyAtMs = now;
    return client;
  }

  private toMessageSummary(message: gmail_v1.Schema$Message): GmailMessageSummary {
    const payload = message.payload;
    const headers = payload?.headers ?? [];
    return {
      id: message.id ?? "",
      threadId: message.threadId ?? "",
      from: getHeader(headers, "from"),
      to: getHeader(headers, "to"),
      subject: getHeader(headers, "subject"),
      date: getHeader(headers, "date"),
      snippet: (message.snippet ?? "").trim(),
      labelIds: message.labelIds ?? [],
    };
  }

  private toMessageDetail(message: gmail_v1.Schema$Message): GmailMessageDetail {
    const summary = this.toMessageSummary(message);
    const bodies = { plain: [] as string[], html: [] as string[] };
    const attachments: GmailMessageAttachment[] = [];
    collectMessageBodies(message.payload, bodies);
    collectAttachments(message.payload, attachments);

    const bodyText = normalizeWhitespace(
      bodies.plain.join("\n\n") || stripHtmlToText(bodies.html.join("\n\n")) || summary.snippet,
    );
    const bodyHtml = normalizeWhitespace(bodies.html.join("\n\n"));

    return {
      ...summary,
      bodyText: truncateInline(bodyText, 30_000),
      bodyHtml: truncateInline(bodyHtml, 30_000),
      historyId: message.historyId ?? "",
      internalDate: message.internalDate ?? "",
      attachments,
    };
  }

  private async resolveAttachments(inputs?: GmailAttachmentInput[]): Promise<MimeAttachment[]> {
    const items = inputs ?? [];
    if (items.length === 0) {
      return [];
    }
    if (items.length > MAX_ATTACHMENT_COUNT) {
      throw new Error(`Demasiados adjuntos (máximo ${MAX_ATTACHMENT_COUNT})`);
    }

    let totalBytes = 0;
    const resolved: MimeAttachment[] = [];
    for (const item of items) {
      const rawPath = item.path?.trim();
      if (!rawPath) {
        throw new Error("Adjunto inválido: path vacío");
      }
      const absolutePath = resolvePath(rawPath);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        throw new Error(`Adjunto inválido, no es archivo: ${rawPath}`);
      }
      if (fileStat.size > MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(
          `Adjunto demasiado grande (${rawPath}, máximo ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024))}MB)`,
        );
      }
      totalBytes += fileStat.size;
      if (totalBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
        throw new Error(
          `Total de adjuntos supera ${Math.floor(MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024))}MB (límite de seguridad)`,
        );
      }
      const data = await readFile(absolutePath);
      const filename = sanitizeFilename(item.filename?.trim() || basename(absolutePath));
      resolved.push({
        filename,
        contentType: item.contentType?.trim() || guessContentType(filename),
        data,
      });
    }

    return resolved;
  }

  private buildRawMessage(params: {
    from?: string;
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: MimeAttachment[];
  }): string {
    const attachments = params.attachments ?? [];
    const headerLines = [
      params.from ? `From: ${params.from}` : "",
      `To: ${params.to}`,
      params.cc ? `Cc: ${params.cc}` : "",
      params.bcc ? `Bcc: ${params.bcc}` : "",
      `Subject: ${encodeMimeHeaderUtf8(params.subject)}`,
      params.inReplyTo ? `In-Reply-To: ${params.inReplyTo}` : "",
      params.references ? `References: ${params.references}` : "",
      "MIME-Version: 1.0",
    ].filter(Boolean);

    if (attachments.length === 0) {
      const lines = [
        ...headerLines,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        params.body,
      ];
      return lines.join("\r\n");
    }

    const boundary = `houdi_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const out: string[] = [
      ...headerLines,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      params.body,
      "",
    ];

    for (const attachment of attachments) {
      out.push(
        `--${boundary}`,
        `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        "",
        toBase64Lines(attachment.data),
        "",
      );
    }
    out.push(`--${boundary}--`, "");
    return out.join("\r\n");
  }

  private async sendRawMessage(params: { rawMessage: string; threadId?: string }): Promise<{ id: string; threadId: string }> {
    const raw = Buffer.from(params.rawMessage, "utf8").toString("base64url");
    const gmail = await this.getGmailClient();
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        ...(params.threadId ? { threadId: params.threadId } : {}),
      },
    });
    return {
      id: response.data.id ?? "",
      threadId: response.data.threadId ?? "",
    };
  }

  private async getMessageMetadata(messageId: string): Promise<gmail_v1.Schema$Message> {
    const gmail = await this.getGmailClient();
    const response = await gmail.users.messages.get({
      userId: "me",
      id: requireNonEmptyMessageId(messageId),
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Reply-To", "Message-ID", "References"],
    });
    return response.data;
  }

  async getProfile(): Promise<{
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
    historyId: string;
  }> {
    const gmail = await this.getGmailClient();
    const response = await gmail.users.getProfile({
      userId: "me",
    });
    return {
      emailAddress: response.data.emailAddress ?? this.accountEmail ?? "",
      messagesTotal: response.data.messagesTotal ?? 0,
      threadsTotal: response.data.threadsTotal ?? 0,
      historyId: response.data.historyId ?? "",
    };
  }

  async listMessages(query?: string, limitInput?: number): Promise<GmailMessageSummary[]> {
    const gmail = await this.getGmailClient();
    const limit = this.resolveLimit(limitInput);
    const normalizedQuery = normalizeSearchQuery(query?.trim() || undefined);
    const request: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: "me",
      maxResults: limit,
      includeSpamTrash: false,
    };
    if (normalizedQuery) {
      request.q = normalizedQuery;
    }
    const list = await gmail.users.messages.list(request);
    const refs = list.data.messages ?? [];
    if (refs.length === 0) {
      return [];
    }

    const settled = await Promise.allSettled(
      refs.map(async (ref) => {
        const id = ref.id ?? "";
        if (!id) {
          return null;
        }
        const response = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        return this.toMessageSummary(response.data);
      }),
    );

    return settled
      .filter((item): item is PromiseFulfilledResult<GmailMessageSummary | null> => item.status === "fulfilled")
      .map((item) => item.value)
      .filter((item): item is GmailMessageSummary => Boolean(item?.id));
  }

  async readMessage(messageId: string): Promise<GmailMessageDetail> {
    const id = requireNonEmptyMessageId(messageId);
    const gmail = await this.getGmailClient();
    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      return this.toMessageDetail(response.data);
    } catch (error) {
      if (!isMetadataScopeFullFormatError(error)) {
        throw error;
      }
      const fallback = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Reply-To", "Message-ID", "References"],
      });
      return this.toMessageDetail(fallback.data);
    }
  }

  async sendMessage(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: GmailAttachmentInput[];
  }): Promise<{ id: string; threadId: string }> {
    const to = normalizeAddressToSend(params.to);
    const subject = normalizeSubject(params.subject);
    const body = normalizeBody(params.body);
    const cc = normalizeAddressList(params.cc, "cc");
    const bcc = normalizeAddressList(params.bcc, "bcc");
    const attachments = await this.resolveAttachments(params.attachments);
    const profile = await this.getProfile();
    const from = profile.emailAddress || this.accountEmail || "";

    const rawMessage = this.buildRawMessage({
      from,
      to,
      subject,
      body,
      cc,
      bcc,
      attachments,
    });

    return await this.sendRawMessage({ rawMessage });
  }

  async createDraft(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: GmailAttachmentInput[];
  }): Promise<{ draftId: string; messageId: string; threadId: string }> {
    const to = normalizeAddressToSend(params.to);
    const subject = normalizeSubject(params.subject);
    const body = normalizeBody(params.body);
    const cc = normalizeAddressList(params.cc, "cc");
    const bcc = normalizeAddressList(params.bcc, "bcc");
    const attachments = await this.resolveAttachments(params.attachments);

    const profile = await this.getProfile();
    const from = profile.emailAddress || this.accountEmail || "";
    const rawMessage = this.buildRawMessage({
      from,
      to,
      subject,
      body,
      cc,
      bcc,
      attachments,
    });

    const gmail = await this.getGmailClient();
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw: Buffer.from(rawMessage, "utf8").toString("base64url"),
        },
      },
    });

    return {
      draftId: response.data.id ?? "",
      messageId: response.data.message?.id ?? "",
      threadId: response.data.message?.threadId ?? "",
    };
  }

  async listDrafts(limitInput?: number): Promise<GmailDraftSummary[]> {
    const gmail = await this.getGmailClient();
    const limit = this.resolveLimit(limitInput);
    const list = await gmail.users.drafts.list({
      userId: "me",
      maxResults: limit,
    });
    const refs = list.data.drafts ?? [];
    if (refs.length === 0) {
      return [];
    }

    const settled = await Promise.allSettled(
      refs.map(async (ref) => {
        const draftId = ref.id ?? "";
        if (!draftId) {
          return null;
        }
        const detail = await gmail.users.drafts.get({
          userId: "me",
          id: draftId,
          format: "metadata",
        });
        const message = detail.data.message;
        const summary = this.toMessageSummary(message ?? {});
        return {
          id: draftId,
          messageId: message?.id ?? "",
          threadId: summary.threadId,
          subject: summary.subject,
          to: summary.to,
          from: summary.from,
          snippet: summary.snippet,
          date: summary.date,
        } satisfies GmailDraftSummary;
      }),
    );

    return settled
      .filter((item): item is PromiseFulfilledResult<GmailDraftSummary | null> => item.status === "fulfilled")
      .map((item) => item.value)
      .filter((item): item is GmailDraftSummary => Boolean(item?.id));
  }

  async readDraft(draftId: string): Promise<GmailDraftDetail> {
    const id = requireNonEmptyMessageId(draftId, "draftId");
    const gmail = await this.getGmailClient();
    let message: gmail_v1.Schema$Message | undefined;
    try {
      const response = await gmail.users.drafts.get({
        userId: "me",
        id,
        format: "full",
      });
      message = response.data.message ?? undefined;
    } catch (error) {
      if (!isMetadataScopeFullFormatError(error)) {
        throw error;
      }
      const fallback = await gmail.users.drafts.get({
        userId: "me",
        id,
        format: "metadata",
      });
      message = fallback.data.message ?? undefined;
    }
    if (!message) {
      throw new Error("Draft no encontrado");
    }
    const detail = this.toMessageDetail(message);
    return {
      id,
      messageId: message.id ?? "",
      threadId: detail.threadId,
      subject: detail.subject,
      to: detail.to,
      from: detail.from,
      snippet: detail.snippet,
      date: detail.date,
      bodyText: detail.bodyText,
      bodyHtml: detail.bodyHtml,
      attachments: detail.attachments,
    };
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    const id = requireNonEmptyMessageId(draftId, "draftId");
    const gmail = await this.getGmailClient();
    const response = await gmail.users.drafts.send({
      userId: "me",
      requestBody: {
        id,
      },
    });
    return {
      id: response.data.id ?? "",
      threadId: response.data.threadId ?? "",
    };
  }

  async deleteDraft(draftId: string): Promise<void> {
    const id = requireNonEmptyMessageId(draftId, "draftId");
    const gmail = await this.getGmailClient();
    await gmail.users.drafts.delete({
      userId: "me",
      id,
    });
  }

  async replyMessage(params: {
    messageId: string;
    body: string;
    cc?: string;
    bcc?: string;
    replyAll?: boolean;
    attachments?: GmailAttachmentInput[];
  }): Promise<{ id: string; threadId: string }> {
    const original = await this.getMessageMetadata(params.messageId);
    const headers = original.payload?.headers ?? [];
    const originalFrom = getHeader(headers, "reply-to") || getHeader(headers, "from");
    const originalTo = getHeader(headers, "to");
    const originalCc = getHeader(headers, "cc");
    const subject = ensurePrefixedSubject(getHeader(headers, "subject") || "(sin asunto)", "Re:");
    const messageIdHeader = getHeader(headers, "message-id");
    const referencesHeader = getHeader(headers, "references");

    const to = normalizeAddressToSend(params.replyAll ? `${originalFrom}, ${originalTo}` : originalFrom);
    const cc = normalizeAddressList(params.cc || (params.replyAll ? originalCc : undefined), "cc");
    const bcc = normalizeAddressList(params.bcc, "bcc");
    const body = normalizeBody(params.body);
    const attachments = await this.resolveAttachments(params.attachments);

    const profile = await this.getProfile();
    const from = profile.emailAddress || this.accountEmail || "";

    const rawMessage = this.buildRawMessage({
      from,
      to,
      subject,
      body,
      cc,
      bcc,
      inReplyTo: messageIdHeader || undefined,
      references: normalizeWhitespace(`${referencesHeader} ${messageIdHeader}`).trim() || undefined,
      attachments,
    });

    return await this.sendRawMessage({
      rawMessage,
      threadId: original.threadId || undefined,
    });
  }

  async forwardMessage(params: {
    messageId: string;
    to: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: GmailAttachmentInput[];
  }): Promise<{ id: string; threadId: string }> {
    const originalDetail = await this.readMessage(params.messageId);
    const subject = ensurePrefixedSubject(originalDetail.subject || "(sin asunto)", "Fwd:");
    const to = normalizeAddressToSend(params.to);
    const cc = normalizeAddressList(params.cc, "cc");
    const bcc = normalizeAddressList(params.bcc, "bcc");
    const body = normalizeBody(params.body);
    const attachments = await this.resolveAttachments(params.attachments);

    const profile = await this.getProfile();
    const from = profile.emailAddress || this.accountEmail || "";

    const forwardedBody = [
      body,
      "",
      "---------- Forwarded message ----------",
      `From: ${originalDetail.from || "-"}`,
      `Date: ${originalDetail.date || "-"}`,
      `Subject: ${originalDetail.subject || "-"}`,
      `To: ${originalDetail.to || "-"}`,
      "",
      originalDetail.bodyText || originalDetail.snippet || "",
    ].join("\n");

    const rawMessage = this.buildRawMessage({
      from,
      to,
      subject,
      body: forwardedBody,
      cc,
      bcc,
      attachments,
    });

    return await this.sendRawMessage({ rawMessage });
  }

  async listThread(threadId: string): Promise<GmailMessageSummary[]> {
    const id = requireNonEmptyMessageId(threadId, "threadId");
    const gmail = await this.getGmailClient();
    const response = await gmail.users.threads.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });
    return (response.data.messages ?? []).map((message) => this.toMessageSummary(message));
  }

  async readThread(threadId: string, limitInput?: number): Promise<GmailMessageDetail[]> {
    const id = requireNonEmptyMessageId(threadId, "threadId");
    const limit = this.resolveLimit(limitInput);
    const gmail = await this.getGmailClient();
    let messages: gmail_v1.Schema$Message[] = [];
    try {
      const response = await gmail.users.threads.get({
        userId: "me",
        id,
        format: "full",
      });
      messages = response.data.messages ?? [];
    } catch (error) {
      if (!isMetadataScopeFullFormatError(error)) {
        throw error;
      }
      const fallback = await gmail.users.threads.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      messages = fallback.data.messages ?? [];
    }
    return messages.slice(0, limit).map((message) => this.toMessageDetail(message));
  }

  async markRead(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    const id = requireNonEmptyMessageId(messageId);
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });
  }

  async markUnread(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    const id = requireNonEmptyMessageId(messageId);
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: {
        addLabelIds: ["UNREAD"],
      },
    });
  }

  async trashMessage(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    const id = requireNonEmptyMessageId(messageId);
    await gmail.users.messages.trash({
      userId: "me",
      id,
    });
  }

  async untrashMessage(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    const id = requireNonEmptyMessageId(messageId);
    await gmail.users.messages.untrash({
      userId: "me",
      id,
    });
  }

  async star(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    const id = requireNonEmptyMessageId(messageId);
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: {
        addLabelIds: ["STARRED"],
      },
    });
  }

  async unstar(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    const id = requireNonEmptyMessageId(messageId);
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: {
        removeLabelIds: ["STARRED"],
      },
    });
  }
}
