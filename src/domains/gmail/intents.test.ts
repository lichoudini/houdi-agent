import assert from "node:assert/strict";
import test from "node:test";
import { detectGmailNaturalIntent, detectGmailRecipientNaturalIntent } from "./intents.js";
import { createGmailTextParsers } from "./text-parsers.js";

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function extractQuotedSegments(text: string): string[] {
  const regex = /"([^"]+)"|'([^']+)'|`([^`]+)`/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    values.push((match[1] || match[2] || match[3] || "").trim());
  }
  return values.filter(Boolean);
}

function normalizeRecipientName(text: string): string {
  return text
    .replace(/[,:;.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateInline(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 1)}…`;
}

const parsers = createGmailTextParsers({
  normalizeIntentText,
  extractQuotedSegments,
  normalizeRecipientName,
  truncateInline,
  gmailMaxResults: 20,
});

const deps = {
  normalizeIntentText,
  extractQuotedSegments,
  extractEmailAddresses: parsers.extractEmailAddresses,
  extractRecipientNameFromText: parsers.extractRecipientNameFromText,
  inferDefaultSelfEmailRecipient: () => "",
  detectGmailAutoContentKind: (
    textNormalized: string,
  ): "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last" | undefined => {
    if (/\b(s?ultim[oa]s?|noticias?|nove(?:dad(?:es)?|ades?)|actualidad|titulares?|news)\b/.test(textNormalized)) {
      return "news";
    }
    return undefined;
  },
  parseGmailLabeledFields: parsers.parseGmailLabeledFields,
  extractLiteralBodyRequest: parsers.extractLiteralBodyRequest,
  extractNaturalSubjectRequest: parsers.extractNaturalSubjectRequest,
  detectCreativeEmailCue: parsers.detectCreativeEmailCue,
  detectGmailDraftRequested: parsers.detectGmailDraftRequested,
  buildGmailDraftInstruction: parsers.buildGmailDraftInstruction,
  shouldAvoidLiteralBodyFallback: parsers.shouldAvoidLiteralBodyFallback,
  parseNaturalLimit: parsers.parseNaturalLimit,
  buildNaturalGmailQuery: parsers.buildNaturalGmailQuery,
  gmailAccountEmail: "jose@vrand.biz",
};

test("gmail send with news topic keeps auto-content mode and avoids missing-subject AI override", () => {
  const intent = detectGmailNaturalIntent(
    "Enviar un correo a nazareno.tomaselli@vrand.biz con las ultimas novedades de boca juniors.",
    deps,
  );
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
  assert.equal(intent.to, "nazareno.tomaselli@vrand.biz");
  assert.equal(intent.autoContentKind, "news");
  assert.notEqual(intent.forceAiByMissingSubject, true);
});

test("gmail send with typoed news words still routes to news auto-content", () => {
  const intent = detectGmailNaturalIntent(
    "enviar un correo a nazareno.tomaselli@vrand.biz con la sultimas noveades de boca juniors",
    deps,
  );
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
  assert.equal(intent.to, "nazareno.tomaselli@vrand.biz");
  assert.equal(intent.autoContentKind, "news");
  assert.notEqual(intent.forceAiByMissingSubject, true);
});

test("gmail send with explicit subject/body keeps explicit values", () => {
  const intent = detectGmailNaturalIntent(
    "Enviar correo a nazareno.tomaselli@vrand.biz asunto:Hola mensaje:Te escribo para confirmar.",
    deps,
  );
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
  assert.equal(intent.subject, "Hola");
  assert.equal(intent.body, "Te escribo para confirmar.");
});

test("gmail send parses natural cc syntax without labels", () => {
  const intent = detectGmailNaturalIntent(
    "Enviar un correo a nazareno.tomaselli@vrand.biz cc a patagonads@gmail.com",
    deps,
  );
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
  assert.equal(intent.to, "nazareno.tomaselli@vrand.biz");
  assert.equal(intent.cc, "patagonads@gmail.com");
});

test("gmail send with 'sobre temas de' requests auto-generated body flow", () => {
  const intent = detectGmailNaturalIntent(
    "Enviar correo a nazareno.tomaselli@vrand.biz con cc patagonads@gmail.com sobre temas de marketing",
    deps,
  );
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
  assert.equal(intent.to, "nazareno.tomaselli@vrand.biz");
  assert.equal(intent.cc, "patagonads@gmail.com");
  assert.equal(intent.draftRequested, true);
  assert.notEqual(intent.forceAiByMissingSubject, true);
});

test("gmail recipients add parses clean name/email from natural sentence", () => {
  const intent = detectGmailRecipientNaturalIntent("Agregá destinatario Carla carla@empresa.com.", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "add");
  assert.equal(intent.name, "Carla");
  assert.equal(intent.email, "carla@empresa.com");
});

test("gmail recipients update parses clean name/email from 'con' phrasing", () => {
  const intent = detectGmailRecipientNaturalIntent(
    "Actualizá destinatario Carla con carla.ops@empresa.com.",
    deps,
  );
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "update");
  assert.equal(intent.name, "Carla");
  assert.equal(intent.email, "carla.ops@empresa.com");
});
