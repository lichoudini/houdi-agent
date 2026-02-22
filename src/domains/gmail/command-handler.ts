import { relative, resolve as resolvePath } from "node:path";
import {
  isGmailRecipientsSubcommand,
  normalizeGmailModifyAction,
  normalizeGmailRecipientsAction,
  parseGmailDraftArgs,
  parseGmailForwardArgs,
  parseGmailListArgs,
  parseGmailReplyArgs,
  parseGmailSendArgs,
  parseGmailThreadArgs,
  parseRecipientsAddArgs,
  parseRecipientsDeleteSelector,
  parseRecipientsEditArgs,
  type ParsedKeyValueOptions,
} from "./command-parser.js";
import { normalizeRecipientEmail, normalizeRecipientName } from "./recipients-manager.js";

export type GmailCommandActor = {
  chatId: number;
  userId: number;
};

type GmailCommandAttachment = {
  filename: string;
  mimeType: string;
  size: number;
};

type GmailCommandMessageSummary = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
};

type GmailCommandMessageDetail = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  labelIds: string[];
  bodyText: string;
  snippet: string;
  attachments?: GmailCommandAttachment[];
};

type GmailCommandDraftSummary = {
  id: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  from: string;
  snippet: string;
  date: string;
};

type GmailCommandDraftDetail = GmailCommandDraftSummary & {
  bodyText: string;
  attachments?: GmailCommandAttachment[];
};

type GmailCommandStatus = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  accountEmail?: string;
  maxResults: number;
};

type GmailCommandProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

type GmailCommandSentMessage = {
  id: string;
  threadId: string;
};

export type GmailCommandAccountService = {
  getStatus: () => GmailCommandStatus;
  getProfile: () => Promise<GmailCommandProfile>;
  listMessages: (query?: string, limitInput?: number) => Promise<GmailCommandMessageSummary[]>;
  readMessage: (messageId: string) => Promise<GmailCommandMessageDetail>;
  sendMessage: (params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: { path: string }[];
  }) => Promise<GmailCommandSentMessage>;
  createDraft: (params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: { path: string }[];
  }) => Promise<{ draftId: string; messageId: string; threadId: string }>;
  listDrafts: (limitInput?: number) => Promise<GmailCommandDraftSummary[]>;
  readDraft: (draftId: string) => Promise<GmailCommandDraftDetail>;
  sendDraft: (draftId: string) => Promise<GmailCommandSentMessage>;
  deleteDraft: (draftId: string) => Promise<void>;
  replyMessage: (params: {
    messageId: string;
    body: string;
    cc?: string;
    bcc?: string;
    replyAll?: boolean;
    attachments?: { path: string }[];
  }) => Promise<GmailCommandSentMessage>;
  forwardMessage: (params: {
    messageId: string;
    to: string;
    body: string;
    cc?: string;
    bcc?: string;
    attachments?: { path: string }[];
  }) => Promise<GmailCommandSentMessage>;
  listThread: (threadId: string) => Promise<GmailCommandMessageSummary[]>;
  readThread: (threadId: string, limitInput?: number) => Promise<GmailCommandMessageDetail[]>;
  markRead: (messageId: string) => Promise<void>;
  markUnread: (messageId: string) => Promise<void>;
  trashMessage: (messageId: string) => Promise<void>;
  untrashMessage: (messageId: string) => Promise<void>;
  star: (messageId: string) => Promise<void>;
  unstar: (messageId: string) => Promise<void>;
};

export type GmailRecipientsRow = {
  name: string;
  email: string;
  nameKey: string;
};

export type GmailCommandDeps<Ctx> = {
  gmailAccount: GmailCommandAccountService;
  parseKeyValueOptions: (tokens: string[]) => ParsedKeyValueOptions;
  listEmailRecipients: (chatId: number) => GmailRecipientsRow[];
  upsertEmailRecipient: (params: { chatId: number; name: string; email: string }) => Promise<{ created: boolean; row: GmailRecipientsRow }>;
  updateEmailRecipientBySelector: (params: {
    chatId: number;
    selector: string;
    nextName?: string;
    nextEmail?: string;
  }) => Promise<{ previous: GmailRecipientsRow; row: GmailRecipientsRow } | null>;
  deleteEmailRecipientBySelector: (chatId: number, selector: string) => Promise<GmailRecipientsRow | null>;
  clearEmailRecipients: (chatId: number) => Promise<number>;
  rememberGmailListResults: (chatId: number, messages: GmailCommandMessageSummary[]) => void;
  rememberGmailListContext: (params: {
    chatId: number;
    title: string;
    messages: GmailCommandMessageSummary[];
    source: string;
  }) => void;
  rememberGmailMessage: (chatId: number, messageId: string) => void;
  getGmailAccessIssue: (ctx: Ctx) => string | null;
  getPolicyCapabilityBlockReason: (chatId: number, capability: "gmail.send") => string | null;
  maybeRequirePlannedConfirmation: (params: {
    ctx: Ctx;
    kind: "gmail-send";
    capability: "gmail.send";
    summary: string;
    payload: Record<string, unknown>;
    source: string;
    userId: number;
  }) => Promise<boolean>;
  safeAudit: (params: {
    type: string;
    chatId: number;
    userId?: number;
    details?: Record<string, unknown>;
  }) => Promise<void>;
  replyLong: (ctx: Ctx, text: string) => Promise<void>;
  replyProgress: (ctx: Ctx, text: string) => Promise<void>;
  truncateInline: (text: string, maxChars: number) => string;
};

function normalizeAttachmentInputs(rawPaths: string[]): { path: string }[] {
  if (rawPaths.length === 0) {
    return [];
  }
  const workspaceRoot = process.cwd();
  return rawPaths.map((rawPath) => {
    const absolute = resolvePath(rawPath);
    const rel = relative(workspaceRoot, absolute);
    if (rel.startsWith("..")) {
      throw new Error(`Adjunto fuera del workspace permitido: ${rawPath}`);
    }
    return { path: absolute };
  });
}

function summarizeAttachmentPaths(paths: string[]): string {
  if (paths.length === 0) {
    return "adjuntos: 0";
  }
  return `adjuntos: ${paths.length}`;
}

function formatAttachmentList(attachments: GmailCommandAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) {
    return "Adjuntos: -";
  }
  return `Adjuntos: ${attachments.map((item) => `${item.filename} (${item.size} bytes)`).join(", ")}`;
}

export async function runGmailCommand<Ctx extends { reply: (text: string) => Promise<unknown>; chat: { id: number } }>(params: {
  ctx: Ctx;
  tokens: string[];
  actor: GmailCommandActor;
  usage: string;
  recipientsUsage: string;
  deps: GmailCommandDeps<Ctx>;
}): Promise<void> {
  const { ctx, actor, usage, recipientsUsage, deps } = params;
  const tokens = [...params.tokens];
  const subcommand = (tokens.shift() ?? "").toLowerCase();

  const ensureOutboundAllowed = async (): Promise<boolean> => {
    const blockReason = deps.getPolicyCapabilityBlockReason(actor.chatId, "gmail.send");
    if (blockReason) {
      await ctx.reply(blockReason);
      return false;
    }
    return true;
  };

  const requestOutboundConfirmation = async (args: {
    summary: string;
    payload: Record<string, unknown>;
    source: string;
  }): Promise<boolean> => {
    return await deps.maybeRequirePlannedConfirmation({
      ctx,
      kind: "gmail-send",
      capability: "gmail.send",
      summary: args.summary,
      payload: args.payload,
      source: args.source,
      userId: actor.userId,
    });
  };

  const handleRecipientsCommand = async (): Promise<void> => {
    const sub = (tokens.shift() ?? "list").toLowerCase();
    const action = normalizeGmailRecipientsAction(sub);
    const parsed = deps.parseKeyValueOptions(tokens);
    try {
      switch (action) {
        case "list": {
          const list = deps.listEmailRecipients(actor.chatId);
          if (list.length === 0) {
            await ctx.reply("No hay destinatarios guardados.");
            return;
          }
          const lines = list.map((item, idx) => `${idx + 1}. ${item.name} <${item.email}>`);
          await deps.replyLong(ctx, [`Destinatarios guardados (${list.length}):`, ...lines].join("\n"));
          return;
        }
        case "add": {
          const addParsed = parseRecipientsAddArgs(parsed);
          if (!addParsed.ok) {
            await ctx.reply(`Faltan datos.\n\n${recipientsUsage}`);
            return;
          }
          const email = normalizeRecipientEmail(addParsed.emailRaw);
          const name = normalizeRecipientName(addParsed.nameRaw);
          if (!name || !email) {
            await ctx.reply(`Faltan datos.\n\n${recipientsUsage}`);
            return;
          }
          const result = await deps.upsertEmailRecipient({ chatId: actor.chatId, name, email });
          await ctx.reply(
            result.created
              ? `Destinatario agregado: ${result.row.name} <${result.row.email}>`
              : `Destinatario actualizado: ${result.row.name} <${result.row.email}>`,
          );
          await deps.safeAudit({
            type: "gmail.recipients_upsert",
            chatId: actor.chatId,
            userId: actor.userId,
            details: {
              created: result.created,
              name: result.row.name,
              email: result.row.email,
            },
          });
          return;
        }
        case "edit": {
          const editParsed = parseRecipientsEditArgs(parsed);
          if (!editParsed.ok) {
            await ctx.reply(`Faltan datos para editar.\n\n${recipientsUsage}`);
            return;
          }
          const updated = await deps.updateEmailRecipientBySelector({
            chatId: actor.chatId,
            selector: editParsed.selector,
            ...(editParsed.nextName ? { nextName: editParsed.nextName } : {}),
            ...(editParsed.nextEmail ? { nextEmail: editParsed.nextEmail } : {}),
          });
          if (!updated) {
            await ctx.reply(`No encontré destinatario "${editParsed.selector}".`);
            return;
          }
          await ctx.reply(
            [
              "Destinatario modificado:",
              `antes: ${updated.previous.name} <${updated.previous.email}>`,
              `ahora: ${updated.row.name} <${updated.row.email}>`,
            ].join("\n"),
          );
          await deps.safeAudit({
            type: "gmail.recipients_update",
            chatId: actor.chatId,
            userId: actor.userId,
            details: {
              selector: editParsed.selector,
              previousName: updated.previous.name,
              previousEmail: updated.previous.email,
              currentName: updated.row.name,
              currentEmail: updated.row.email,
            },
          });
          return;
        }
        case "delete": {
          const selector = parseRecipientsDeleteSelector(parsed);
          if (!selector) {
            await ctx.reply(`Indica el destinatario a eliminar.\n\n${recipientsUsage}`);
            return;
          }
          const removed = await deps.deleteEmailRecipientBySelector(actor.chatId, selector);
          if (!removed) {
            await ctx.reply(`No encontré destinatario "${selector}".`);
            return;
          }
          await ctx.reply(`Destinatario eliminado: ${removed.name} <${removed.email}>`);
          await deps.safeAudit({
            type: "gmail.recipients_delete",
            chatId: actor.chatId,
            userId: actor.userId,
            details: {
              selector,
              name: removed.name,
              email: removed.email,
            },
          });
          return;
        }
        case "clear": {
          const removedCount = await deps.clearEmailRecipients(actor.chatId);
          await ctx.reply(`Destinatarios eliminados: ${removedCount}`);
          await deps.safeAudit({
            type: "gmail.recipients_clear",
            chatId: actor.chatId,
            userId: actor.userId,
            details: { removedCount },
          });
          return;
        }
        default:
          await ctx.reply(`Subcomando recipients no reconocido: ${sub}\n\n${recipientsUsage}`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`No pude operar destinatarios: ${message}`);
      await deps.safeAudit({
        type: "gmail.recipients_failed",
        chatId: actor.chatId,
        userId: actor.userId,
        details: {
          sub,
          error: message,
        },
      });
    }
  };

  const runModifyAction = async (action: NonNullable<ReturnType<typeof normalizeGmailModifyAction>>, messageId: string): Promise<void> => {
    if (action === "markread") {
      await deps.gmailAccount.markRead(messageId);
    } else if (action === "markunread") {
      await deps.gmailAccount.markUnread(messageId);
    } else if (action === "trash") {
      await deps.gmailAccount.trashMessage(messageId);
    } else if (action === "untrash") {
      await deps.gmailAccount.untrashMessage(messageId);
    } else if (action === "star") {
      await deps.gmailAccount.star(messageId);
    } else if (action === "unstar") {
      await deps.gmailAccount.unstar(messageId);
    }
    deps.rememberGmailMessage(ctx.chat.id, messageId);
    await ctx.reply(`OK: ${action} aplicado a ${messageId}`);
    await deps.safeAudit({
      type: "gmail.modify",
      chatId: actor.chatId,
      userId: actor.userId,
      details: {
        action,
        messageId,
      },
    });
  };

  if (subcommand === "status") {
    const status = deps.gmailAccount.getStatus();
    await ctx.reply(
      [
        `Habilitado: ${status.enabled ? "sí" : "no"}`,
        `Configurado: ${status.configured ? "sí" : "no"}`,
        `Cuenta: ${status.accountEmail || "n/d"}`,
        `Max resultados: ${status.maxResults}`,
        status.missing.length > 0 ? `Faltan: ${status.missing.join(", ")}` : "Faltan: ninguno",
      ].join("\n"),
    );
    return;
  }

  if (isGmailRecipientsSubcommand(subcommand)) {
    await handleRecipientsCommand();
    return;
  }

  const accessIssue = deps.getGmailAccessIssue(ctx);
  if (accessIssue) {
    await ctx.reply(accessIssue);
    return;
  }

  try {
    switch (subcommand) {
      case "profile": {
        const profile = await deps.gmailAccount.getProfile();
        await ctx.reply(
          [
            `Email: ${profile.emailAddress || "n/d"}`,
            `Mensajes: ${profile.messagesTotal}`,
            `Threads: ${profile.threadsTotal}`,
            `HistoryId: ${profile.historyId || "n/d"}`,
          ].join("\n"),
        );
        await deps.safeAudit({
          type: "gmail.profile",
          chatId: actor.chatId,
          userId: actor.userId,
        });
        return;
      }
      case "list": {
        const parsed = deps.parseKeyValueOptions(tokens);
        const listParsed = parseGmailListArgs(parsed);
        if (!listParsed.ok) {
          await ctx.reply(listParsed.error);
          return;
        }
        const query = listParsed.query;
        const limit = listParsed.limit;
        await deps.replyProgress(ctx, `Consultando Gmail${query ? ` (query: ${query})` : ""}...`);
        const messages = await deps.gmailAccount.listMessages(query, limit);
        if (messages.length === 0) {
          await ctx.reply("Sin mensajes para ese filtro.");
          return;
        }
        deps.rememberGmailListResults(ctx.chat.id, messages);
        deps.rememberGmailListContext({
          chatId: ctx.chat.id,
          title: `Gmail: ${query || "inbox"}`,
          messages,
          source: "telegram:/gmail",
        });
        const lines = messages.map((message, index) =>
          [
            `${index + 1}. ${message.subject || "(sin asunto)"}`,
            `id: ${message.id}`,
            `thread: ${message.threadId || "-"}`,
            `from: ${message.from || "-"}`,
            `date: ${message.date || "-"}`,
            message.snippet ? `snippet: ${deps.truncateInline(message.snippet, 220)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        await deps.replyLong(ctx, [`Mensajes (${messages.length}):`, ...lines].join("\n\n"));
        await deps.safeAudit({
          type: "gmail.list",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            count: messages.length,
            query: query ?? "",
          },
        });
        return;
      }
      case "read": {
        const messageId = tokens[0]?.trim();
        if (!messageId) {
          await ctx.reply(`Falta messageId.\n\n${usage}`);
          return;
        }
        const detail = await deps.gmailAccount.readMessage(messageId);
        deps.rememberGmailMessage(ctx.chat.id, detail.id);
        await deps.replyLong(
          ctx,
          [
            `Subject: ${detail.subject || "(sin asunto)"}`,
            `From: ${detail.from || "-"}`,
            `To: ${detail.to || "-"}`,
            `Date: ${detail.date || "-"}`,
            `Labels: ${detail.labelIds.join(", ") || "-"}`,
            `MessageId: ${detail.id}`,
            `ThreadId: ${detail.threadId || "-"}`,
            formatAttachmentList(detail.attachments),
            "",
            detail.bodyText || detail.snippet || "(sin cuerpo legible)",
          ].join("\n"),
        );
        await deps.safeAudit({
          type: "gmail.read",
          chatId: actor.chatId,
          userId: actor.userId,
          details: { messageId },
        });
        return;
      }
      case "send": {
        if (!(await ensureOutboundAllowed())) {
          return;
        }
        const parsed = deps.parseKeyValueOptions(tokens);
        const sendParsed = parseGmailSendArgs(parsed);
        if (!sendParsed.ok) {
          await ctx.reply(`${sendParsed.error}\n\n${usage}`);
          return;
        }
        const attachments = normalizeAttachmentInputs(sendParsed.attachments);
        if (
          await requestOutboundConfirmation({
            summary: [
              `to: ${sendParsed.to}`,
              `subject: ${sendParsed.subject}`,
              `body_chars: ${sendParsed.body.length}`,
              summarizeAttachmentPaths(sendParsed.attachments),
            ].join("\n"),
            payload: {
              to: sendParsed.to,
              subject: sendParsed.subject,
              body: sendParsed.body,
              cc: sendParsed.cc ?? "",
              bcc: sendParsed.bcc ?? "",
              attachments: sendParsed.attachments,
            },
            source: "telegram:/gmail-send",
          })
        ) {
          return;
        }
        const sent = await deps.gmailAccount.sendMessage({
          to: sendParsed.to,
          subject: sendParsed.subject,
          body: sendParsed.body,
          cc: sendParsed.cc,
          bcc: sendParsed.bcc,
          attachments,
        });
        deps.rememberGmailMessage(ctx.chat.id, sent.id);
        await ctx.reply(`Email enviado.\nmessageId=${sent.id}\nthreadId=${sent.threadId}`);
        await deps.safeAudit({
          type: "gmail.send",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            to: sendParsed.to,
            subjectLength: sendParsed.subject.length,
            bodyLength: sendParsed.body.length,
            cc: sendParsed.cc ?? "",
            bcc: sendParsed.bcc ? "[set]" : "",
            attachmentCount: sendParsed.attachments.length,
            messageId: sent.id,
            threadId: sent.threadId,
          },
        });
        return;
      }
      case "reply": {
        if (!(await ensureOutboundAllowed())) {
          return;
        }
        const parsed = deps.parseKeyValueOptions(tokens);
        const replyParsed = parseGmailReplyArgs(parsed);
        if (!replyParsed.ok) {
          await ctx.reply(`${replyParsed.error}\n\n${usage}`);
          return;
        }
        const attachments = normalizeAttachmentInputs(replyParsed.attachments);
        if (
          await requestOutboundConfirmation({
            summary: [
              `reply_to_message: ${replyParsed.messageId}`,
              `reply_all: ${replyParsed.replyAll ? "sí" : "no"}`,
              `body_chars: ${replyParsed.body.length}`,
              summarizeAttachmentPaths(replyParsed.attachments),
            ].join("\n"),
            payload: {
              messageId: replyParsed.messageId,
              body: replyParsed.body,
              cc: replyParsed.cc ?? "",
              bcc: replyParsed.bcc ?? "",
              replyAll: replyParsed.replyAll,
              attachments: replyParsed.attachments,
            },
            source: "telegram:/gmail-reply",
          })
        ) {
          return;
        }
        const sent = await deps.gmailAccount.replyMessage({
          messageId: replyParsed.messageId,
          body: replyParsed.body,
          cc: replyParsed.cc,
          bcc: replyParsed.bcc,
          replyAll: replyParsed.replyAll,
          attachments,
        });
        deps.rememberGmailMessage(ctx.chat.id, sent.id);
        await ctx.reply(`Reply enviado.\nmessageId=${sent.id}\nthreadId=${sent.threadId}`);
        await deps.safeAudit({
          type: "gmail.reply",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            messageId: replyParsed.messageId,
            replyAll: replyParsed.replyAll,
            attachmentCount: replyParsed.attachments.length,
            sentMessageId: sent.id,
            threadId: sent.threadId,
          },
        });
        return;
      }
      case "forward": {
        if (!(await ensureOutboundAllowed())) {
          return;
        }
        const parsed = deps.parseKeyValueOptions(tokens);
        const forwardParsed = parseGmailForwardArgs(parsed);
        if (!forwardParsed.ok) {
          await ctx.reply(`${forwardParsed.error}\n\n${usage}`);
          return;
        }
        const attachments = normalizeAttachmentInputs(forwardParsed.attachments);
        if (
          await requestOutboundConfirmation({
            summary: [
              `forward_message: ${forwardParsed.messageId}`,
              `to: ${forwardParsed.to}`,
              `body_chars: ${forwardParsed.body.length}`,
              summarizeAttachmentPaths(forwardParsed.attachments),
            ].join("\n"),
            payload: {
              messageId: forwardParsed.messageId,
              to: forwardParsed.to,
              body: forwardParsed.body,
              cc: forwardParsed.cc ?? "",
              bcc: forwardParsed.bcc ?? "",
              attachments: forwardParsed.attachments,
            },
            source: "telegram:/gmail-forward",
          })
        ) {
          return;
        }
        const sent = await deps.gmailAccount.forwardMessage({
          messageId: forwardParsed.messageId,
          to: forwardParsed.to,
          body: forwardParsed.body,
          cc: forwardParsed.cc,
          bcc: forwardParsed.bcc,
          attachments,
        });
        deps.rememberGmailMessage(ctx.chat.id, sent.id);
        await ctx.reply(`Forward enviado.\nmessageId=${sent.id}\nthreadId=${sent.threadId}`);
        await deps.safeAudit({
          type: "gmail.forward",
          chatId: actor.chatId,
          userId: actor.userId,
          details: {
            messageId: forwardParsed.messageId,
            to: forwardParsed.to,
            attachmentCount: forwardParsed.attachments.length,
            sentMessageId: sent.id,
            threadId: sent.threadId,
          },
        });
        return;
      }
      case "draft": {
        const parsed = deps.parseKeyValueOptions(tokens);
        const draftParsed = parseGmailDraftArgs(parsed);
        if (!draftParsed.ok) {
          await ctx.reply(`${draftParsed.error}\n\n${usage}`);
          return;
        }

        if (draftParsed.action === "list") {
          const drafts = await deps.gmailAccount.listDrafts(draftParsed.limit);
          if (drafts.length === 0) {
            await ctx.reply("No hay drafts.");
            return;
          }
          const lines = drafts.map((draft, index) =>
            [
              `${index + 1}. ${draft.subject || "(sin asunto)"}`,
              `draftId: ${draft.id}`,
              `to: ${draft.to || "-"}`,
              `date: ${draft.date || "-"}`,
              draft.snippet ? `snippet: ${deps.truncateInline(draft.snippet, 220)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
          await deps.replyLong(ctx, [`Drafts (${drafts.length}):`, ...lines].join("\n\n"));
          return;
        }

        if (draftParsed.action === "read") {
          const draft = await deps.gmailAccount.readDraft(draftParsed.draftId);
          await deps.replyLong(
            ctx,
            [
              `DraftId: ${draft.id}`,
              `Subject: ${draft.subject || "(sin asunto)"}`,
              `From: ${draft.from || "-"}`,
              `To: ${draft.to || "-"}`,
              `Date: ${draft.date || "-"}`,
              formatAttachmentList(draft.attachments),
              "",
              draft.bodyText || draft.snippet || "(sin cuerpo legible)",
            ].join("\n"),
          );
          return;
        }

        if (draftParsed.action === "delete") {
          await deps.gmailAccount.deleteDraft(draftParsed.draftId);
          await ctx.reply(`Draft eliminado: ${draftParsed.draftId}`);
          return;
        }

        if (draftParsed.action === "send") {
          if (!(await ensureOutboundAllowed())) {
            return;
          }
          if (
            await requestOutboundConfirmation({
              summary: `send_draft: ${draftParsed.draftId}`,
              payload: { draftId: draftParsed.draftId },
              source: "telegram:/gmail-draft-send",
            })
          ) {
            return;
          }
          const sent = await deps.gmailAccount.sendDraft(draftParsed.draftId);
          deps.rememberGmailMessage(ctx.chat.id, sent.id);
          await ctx.reply(`Draft enviado.\nmessageId=${sent.id}\nthreadId=${sent.threadId}`);
          return;
        }

        if (draftParsed.action === "create") {
          const attachments = normalizeAttachmentInputs(draftParsed.attachments);
          const created = await deps.gmailAccount.createDraft({
            to: draftParsed.to,
            subject: draftParsed.subject,
            body: draftParsed.body,
            cc: draftParsed.cc,
            bcc: draftParsed.bcc,
            attachments,
          });
          await ctx.reply(`Draft creado.\ndraftId=${created.draftId}\nmessageId=${created.messageId}\nthreadId=${created.threadId}`);
          return;
        }
        return;
      }
      case "thread": {
        const parsed = deps.parseKeyValueOptions(tokens);
        const threadParsed = parseGmailThreadArgs(parsed);
        if (!threadParsed.ok) {
          await ctx.reply(`${threadParsed.error}\n\n${usage}`);
          return;
        }

        const details = await deps.gmailAccount.readThread(threadParsed.threadId, threadParsed.limit);
        if (details.length === 0) {
          await ctx.reply("Thread sin mensajes.");
          return;
        }
        const lines = details.map((item, index) =>
          [
            `${index + 1}. ${item.subject || "(sin asunto)"}`,
            `messageId: ${item.id}`,
            `from: ${item.from || "-"}`,
            `date: ${item.date || "-"}`,
            formatAttachmentList(item.attachments),
            item.bodyText ? `body: ${deps.truncateInline(item.bodyText, 180)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        await deps.replyLong(ctx, [`Thread ${threadParsed.threadId} (${details.length}):`, ...lines].join("\n\n"));
        return;
      }
      default: {
        const modifyAction = normalizeGmailModifyAction(subcommand);
        if (modifyAction) {
          const messageId = tokens[0]?.trim();
          if (!messageId) {
            await ctx.reply(`Falta messageId.\n\n${usage}`);
            return;
          }
          await runModifyAction(modifyAction, messageId);
          return;
        }
        await ctx.reply(`Subcomando no reconocido: ${subcommand}\n\n${usage}`);
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Error Gmail: ${message}`);
    await deps.safeAudit({
      type: "gmail.failed",
      chatId: actor.chatId,
      userId: actor.userId,
      details: {
        subcommand,
        error: message,
      },
    });
  }
}
