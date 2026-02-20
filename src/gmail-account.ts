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

export type GmailMessageDetail = GmailMessageSummary & {
  bodyText: string;
  bodyHtml: string;
  historyId: string;
  internalDate: string;
};

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

function encodeMimeHeaderUtf8(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value;
  }
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

export class GmailAccountService {
  private readonly enabled: boolean;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly refreshToken?: string;
  private readonly accountEmail?: string;
  private readonly maxResults: number;

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

    const oauth2 = new google.auth.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
    oauth2.setCredentials({
      refresh_token: this.refreshToken,
    });

    // Trigger token refresh/auth validation early.
    await oauth2.getAccessToken();

    return google.gmail({
      version: "v1",
      auth: oauth2,
    });
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
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query?.trim() || undefined,
      maxResults: limit,
      includeSpamTrash: false,
    });
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
    const id = messageId.trim();
    if (!id) {
      throw new Error("messageId vacío");
    }

    const gmail = await this.getGmailClient();
    const response = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    const message = response.data;
    const summary = this.toMessageSummary(message);
    const bodies = { plain: [] as string[], html: [] as string[] };
    collectMessageBodies(message.payload, bodies);

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
    };
  }

  async sendMessage(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<{ id: string; threadId: string }> {
    const to = params.to.trim();
    const subject = params.subject.trim();
    const body = params.body.trim();
    if (!to) {
      throw new Error("to vacío");
    }
    if (!subject) {
      throw new Error("subject vacío");
    }
    if (!body) {
      throw new Error("body vacío");
    }

    const profile = await this.getProfile();
    const from = profile.emailAddress || this.accountEmail || "";
    const cc = params.cc?.trim();
    const bcc = params.bcc?.trim();

    const rawMessage = [
      from ? `From: ${from}` : "",
      `To: ${to}`,
      cc ? `Cc: ${cc}` : "",
      bcc ? `Bcc: ${bcc}` : "",
      `Subject: ${encodeMimeHeaderUtf8(subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
    ]
      .filter(Boolean)
      .join("\r\n");

    const raw = Buffer.from(rawMessage, "utf8").toString("base64url");
    const gmail = await this.getGmailClient();
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
      },
    });
    return {
      id: response.data.id ?? "",
      threadId: response.data.threadId ?? "",
    };
  }

  async markRead(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId.trim(),
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });
  }

  async markUnread(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId.trim(),
      requestBody: {
        addLabelIds: ["UNREAD"],
      },
    });
  }

  async trashMessage(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    await gmail.users.messages.trash({
      userId: "me",
      id: messageId.trim(),
    });
  }

  async untrashMessage(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    await gmail.users.messages.untrash({
      userId: "me",
      id: messageId.trim(),
    });
  }

  async star(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId.trim(),
      requestBody: {
        addLabelIds: ["STARRED"],
      },
    });
  }

  async unstar(messageId: string): Promise<void> {
    const gmail = await this.getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId.trim(),
      requestBody: {
        removeLabelIds: ["STARRED"],
      },
    });
  }
}
