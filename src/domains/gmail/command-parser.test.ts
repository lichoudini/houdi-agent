import assert from "node:assert/strict";
import test from "node:test";
import {
  isGmailRecipientsSubcommand,
  normalizeGmailModifyAction,
  normalizeGmailRecipientsAction,
  parseAttachmentPaths,
  parseGmailDraftArgs,
  parseGmailForwardArgs,
  parseGmailListArgs,
  parseGmailReplyArgs,
  parseGmailSendArgs,
  parseGmailThreadArgs,
  parseRecipientsAddArgs,
  parseRecipientsDeleteSelector,
  parseRecipientsEditArgs,
} from "./command-parser.js";

test("gmail command parser recognizes recipients aliases", () => {
  assert.equal(isGmailRecipientsSubcommand("recipients"), true);
  assert.equal(isGmailRecipientsSubcommand("recipient"), true);
  assert.equal(isGmailRecipientsSubcommand("destinatarios"), true);
  assert.equal(isGmailRecipientsSubcommand("list"), false);
});

test("gmail command parser normalizes recipients actions", () => {
  assert.equal(normalizeGmailRecipientsAction("ls"), "list");
  assert.equal(normalizeGmailRecipientsAction("create"), "add");
  assert.equal(normalizeGmailRecipientsAction("modificar"), "edit");
  assert.equal(normalizeGmailRecipientsAction("remove"), "delete");
  assert.equal(normalizeGmailRecipientsAction("wipe"), "clear");
});

test("gmail command parser validates list limit", () => {
  const parsed = parseGmailListArgs({ args: ["from:juan"], options: { limit: "0" } });
  assert.equal(parsed.ok, false);
});

test("gmail command parser parses send args with cc/bcc and attachments", () => {
  const parsed = parseGmailSendArgs({
    args: ["ana@empresa.com", "Asunto", "Cuerpo", "extra"],
    options: { cc: "cc@empresa.com", bcc: "bcc@empresa.com", attach: "./a.pdf,./b.txt" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.to, "ana@empresa.com");
  assert.equal(parsed.subject, "Asunto");
  assert.equal(parsed.body, "Cuerpo extra");
  assert.equal(parsed.cc, "cc@empresa.com");
  assert.equal(parsed.bcc, "bcc@empresa.com");
  assert.deepEqual(parsed.attachments, ["./a.pdf", "./b.txt"]);
});

test("gmail command parser parses reply args", () => {
  const parsed = parseGmailReplyArgs({
    args: ["msg123", "Gracias", "por", "el", "email"],
    options: { all: "true" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.messageId, "msg123");
  assert.equal(parsed.replyAll, true);
  assert.equal(parsed.body, "Gracias por el email");
});

test("gmail command parser parses forward args", () => {
  const parsed = parseGmailForwardArgs({
    args: ["msg123", "dest@empresa.com", "Te", "reenvio", "esto"],
    options: { files: "x.pdf;y.csv" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.messageId, "msg123");
  assert.equal(parsed.to, "dest@empresa.com");
  assert.equal(parsed.body, "Te reenvio esto");
  assert.deepEqual(parsed.attachments, ["x.pdf", "y.csv"]);
});

test("gmail command parser parses draft create and read", () => {
  const create = parseGmailDraftArgs({
    args: ["create", "ana@empresa.com", "Asunto", "Borrador"],
    options: { attachments: "./x.txt" },
  });
  assert.equal(create.ok, true);
  if (create.ok && create.action === "create") {
    assert.deepEqual(create.attachments, ["./x.txt"]);
  }

  const read = parseGmailDraftArgs({ args: ["read", "dr_123"], options: {} });
  assert.equal(read.ok, true);
  if (read.ok && read.action === "read") {
    assert.equal(read.draftId, "dr_123");
  }
});

test("gmail command parser parses thread args", () => {
  const parsed = parseGmailThreadArgs({ args: ["th_123"], options: { limit: "7" } });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.threadId, "th_123");
  assert.equal(parsed.limit, 7);
});

test("gmail command parser parses recipients add args", () => {
  const parsed = parseRecipientsAddArgs({
    args: ["Ana", "Lopez", "ana@empresa.com"],
    options: {},
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.nameRaw, "Ana Lopez");
  assert.equal(parsed.emailRaw, "ana@empresa.com");
});

test("gmail command parser parses recipients edit args from tail", () => {
  const parsed = parseRecipientsEditArgs({
    args: ["ana", "Ana", "López", "ana.nueva@empresa.com"],
    options: {},
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.selector, "ana");
  assert.equal(parsed.nextName, "Ana López");
  assert.equal(parsed.nextEmail, "ana.nueva@empresa.com");
});

test("gmail command parser parses recipients delete selector", () => {
  const selector = parseRecipientsDeleteSelector({
    args: [],
    options: { name: "ana lopez" },
  });
  assert.equal(selector, "ana lopez");
});

test("gmail command parser normalizes modify actions", () => {
  assert.equal(normalizeGmailModifyAction("markread"), "markread");
  assert.equal(normalizeGmailModifyAction("unstar"), "unstar");
  assert.equal(normalizeGmailModifyAction("foo"), null);
});

test("gmail parser parses attachment paths", () => {
  assert.deepEqual(parseAttachmentPaths("a.pdf,b.csv;c.png"), ["a.pdf", "b.csv", "c.png"]);
  assert.deepEqual(parseAttachmentPaths(""), []);
});
