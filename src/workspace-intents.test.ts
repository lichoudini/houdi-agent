import test from "node:test";
import assert from "node:assert/strict";
import { detectWorkspaceNaturalIntent } from "./domains/workspace/intents.js";
import { createWorkspaceTextParsers } from "./domains/workspace/text-parsers.js";
import {
  detectSimpleTextExtensionHint,
  looksLikeWorkspacePathCandidate,
  parseWorkspaceFileIndexReference,
  pickFirstNonEmpty,
} from "./domains/workspace/intent-helpers.js";

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .replace(/\s+/g, " ")
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

function normalizeWorkspaceRelativePath(raw: string): string {
  const value = raw.trim().replace(/^workspace\//i, "").replace(/^\/+/, "");
  if (!value) {
    return "";
  }
  const cleaned = value
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .replace(/[,:;!?]+$/g, "")
    .trim();
  return cleaned;
}

function cleanWorkspacePathPhrase(raw: string): string {
  const rawTrimmed = raw.trim();
  const trailingDots = rawTrimmed.match(/\.{2,}$/)?.[0] ?? "";
  const cleaned = rawTrimmed
    .trim()
    .replace(/^[\s:.,;!?¿¡-]+|[\s:.,;!?¿¡-]+$/g, "")
    .replace(/\s+(?:en|a|hacia)\s*$/i, "");
  const normalized = normalizeWorkspaceRelativePath(cleaned);
  if (!normalized || !trailingDots) {
    return normalized;
  }
  if (normalized.endsWith(trailingDots)) {
    return normalized;
  }
  return `${normalized}${trailingDots}`;
}

function extractSimpleFilePathCandidate(text: string): string {
  const token = text.match(/\b[\w./-]+\.[a-z0-9]{2,8}\b/i)?.[0] ?? "";
  return normalizeWorkspaceRelativePath(token);
}

const workspaceParsers = createWorkspaceTextParsers({
  normalizeIntentText,
  normalizeWorkspaceRelativePath,
  cleanWorkspacePathPhrase,
  extractQuotedSegments,
});

const deps = {
  normalizeIntentText,
  extractQuotedSegments,
  normalizeWorkspaceRelativePath,
  cleanWorkspacePathPhrase,
  extractSimpleFilePathCandidate,
  extractWorkspaceDeletePathCandidate: workspaceParsers.extractWorkspaceDeletePathCandidate,
  extractWorkspaceDeleteExtensions: workspaceParsers.extractWorkspaceDeleteExtensions,
  extractWorkspaceDeleteContentsPath: workspaceParsers.extractWorkspaceDeleteContentsPath,
  extractWorkspaceNameSelectorFromSegment: workspaceParsers.extractWorkspaceNameSelectorFromSegment,
  pickFirstNonEmpty,
  detectSimpleTextExtensionHint: (text: string) => detectSimpleTextExtensionHint(text, normalizeIntentText),
  resolveWorkspaceWritePathWithHint: (rawPath: string, extensionHint?: string) => {
    const base = normalizeWorkspaceRelativePath(rawPath);
    if (!base) {
      return "";
    }
    if (/\.[a-z0-9]{2,8}$/i.test(base) || !extensionHint) {
      return base;
    }
    return `${base}${extensionHint}`;
  },
  extractNaturalWorkspaceWriteContent: workspaceParsers.extractNaturalWorkspaceWriteContent,
  looksLikeWorkspacePathCandidate: (raw: string) => looksLikeWorkspacePathCandidate(raw, normalizeWorkspaceRelativePath),
  parseWorkspaceFileIndexReference: (text: string) => parseWorkspaceFileIndexReference(text, normalizeIntentText),
};

test("write intent wins when content mentions words similar to move", () => {
  const input = [
    "Editar michael.txt con un poema sobre Michael Jackson.",
    "contenido: En la luna baila luz de estrellas,",
    "sus movimientos hipnotizan.",
  ].join("\n");
  const intent = detectWorkspaceNaturalIntent(input, deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "write");
  assert.equal(intent.path, "michael.txt");
});

test("move intent still works for explicit move verbs", () => {
  const intent = detectWorkspaceNaturalIntent("Mover michael.txt a archivados/michael.txt", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "move");
});

test("rename intent works for explicit rename verbs", () => {
  const intent = detectWorkspaceNaturalIntent("Renombrar michael.txt a moonwalk.txt", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "rename");
});

test("copy intent works for explicit copy verbs", () => {
  const intent = detectWorkspaceNaturalIntent("Copiar moonwalk.txt a backup/moonwalk.txt", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "copy");
});

test("delete intent works for explicit delete verbs", () => {
  const intent = detectWorkspaceNaturalIntent("Eliminar moonwalk.txt", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "delete");
});

test("send intent works for explicit send verbs", () => {
  const intent = detectWorkspaceNaturalIntent("Enviar moonwalk.txt", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
});

test("read intent works for explicit file view requests", () => {
  const intent = detectWorkspaceNaturalIntent("Ver delta-arlas-ciqfg.txt", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "read");
  assert.equal(intent.path, "delta-arlas-ciqfg.txt");
});

test("read intent works as content follow-up without explicit path", () => {
  const intent = detectWorkspaceNaturalIntent("Muéstrame el contenido", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "read");
  assert.equal(intent.path, undefined);
});

test("list intent preserves ellipsis path placeholder for workspace autocomplete", () => {
  const intent = detectWorkspaceNaturalIntent("listar /workspace/img...", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "list");
  assert.equal(intent.path, "img...");
});

test("delete intent detects delete-contents for folder phrasing", () => {
  const intent = detectWorkspaceNaturalIntent("Eliminar todos los archivos de la carpeta workspace/images", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "delete");
  assert.ok(intent.deleteContentsOfPath);
  assert.ok(intent.deleteContentsOfPath.endsWith("images"));
});

test("delete intent keeps direct folder delete when no contents cue is present", () => {
  const intent = detectWorkspaceNaturalIntent("Eliminar carpeta workspace/images", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "delete");
  assert.equal(intent.deleteContentsOfPath, undefined);
  assert.equal(intent.path, "images");
});

test("write intent preserves fuzzy two-dot path target for later autocomplete", () => {
  const intent = detectWorkspaceNaturalIntent("Redactar un poema y guardarlo en el archivo mag..", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "write");
  assert.equal(intent.path, "mag..");
});

test("write intent detects edit path with ellipsis and inline content", () => {
  const intent = detectWorkspaceNaturalIntent("Editar leo... con otro poema", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "write");
  assert.equal(intent.path, "leo...");
  assert.equal(intent.content, "otro poema");
});

test("write intent detects en path escribir content", () => {
  const intent = detectWorkspaceNaturalIntent("En leo... escribir otro poema", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "write");
  assert.equal(intent.path, "leo...");
  assert.equal(intent.content, "otro poema");
});

test("write intent detects en archivo path escribir content", () => {
  const intent = detectWorkspaceNaturalIntent("En archivo leo... escribir otro poema", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "write");
  assert.equal(intent.path, "leo...");
  assert.equal(intent.content, "otro poema");
});

test("delete intent does not infer partial target token without ellipsis", () => {
  const intent = detectWorkspaceNaturalIntent("Borra mag", deps);
  assert.equal(intent.shouldHandle, false);
});

test("send intent does not infer partial target token without ellipsis", () => {
  const intent = detectWorkspaceNaturalIntent("Enviame mag", deps);
  assert.equal(intent.shouldHandle, false);
});

test("send intent accepts explicit ellipsis target token", () => {
  const intent = detectWorkspaceNaturalIntent("Enviame mag...", deps);
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "send");
  assert.equal(intent.path, "mag...");
});

test("send intent ignores generic compact non-file nouns", () => {
  const intent = detectWorkspaceNaturalIntent("Enviame resumen", deps);
  assert.equal(intent.shouldHandle, false);
});
