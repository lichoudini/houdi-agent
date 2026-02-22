import assert from "node:assert/strict";
import test from "node:test";
import { createGmailTextParsers } from "./text-parsers.js";

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function extractQuotedSegments(text: string): string[] {
  const regex = /"([^"]+)"|'([^']+)'|`([^`]+)`|“([^”]+)”|«([^»]+)»/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    values.push((match[1] || match[2] || match[3] || match[4] || match[5] || "").trim());
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

test("extractNewsTopicFromText obtiene tema en envio con novedades y destinatario", () => {
  const topic = parsers.extractNewsTopicFromText(
    "Enviar un correo a nazareno.tomaselli@vrand.biz con las ultimas novedades de boca juniors.",
  );
  assert.equal(topic, "boca juniors");
});

test("extractNewsTopicFromText soporta tema etiquetado", () => {
  const topic = parsers.extractNewsTopicFromText('enviame un email con noticias tema: "marketing digital"');
  assert.equal(topic, "marketing digital");
});

test("extractNewsTopicFromText tolera typos comunes de noticias", () => {
  const topic = parsers.extractNewsTopicFromText("enviar un correo con la sultimas noveades de bocajuniors");
  assert.equal(topic, "bocajuniors");
});
