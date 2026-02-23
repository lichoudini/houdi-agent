#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { detectGmailNaturalIntent, detectGmailRecipientNaturalIntent } from "../../dist/domains/gmail/intents.js";
import { createGmailTextParsers } from "../../dist/domains/gmail/text-parsers.js";
import { detectWorkspaceNaturalIntent } from "../../dist/domains/workspace/intents.js";
import { createWorkspaceTextParsers } from "../../dist/domains/workspace/text-parsers.js";
import {
  detectSimpleTextExtensionHint,
  looksLikeWorkspacePathCandidate,
  parseWorkspaceFileIndexReference,
  pickFirstNonEmpty,
} from "../../dist/domains/workspace/intent-helpers.js";
import { detectSelfMaintenanceIntent } from "../../dist/domains/selfskill/intents.js";

const inputPath = path.resolve(process.cwd(), process.argv[2] || "datasets/domain-action-intents.es-ar.jsonl");

function normalizeIntentText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractQuotedSegments(text) {
  const regex = /"([^"]+)"|'([^']+)'|`([^`]+)`/g;
  const values = [];
  let match;
  while ((match = regex.exec(text))) {
    values.push((match[1] || match[2] || match[3] || "").trim());
  }
  return values.filter(Boolean);
}

function normalizeRecipientName(text) {
  return String(text)
    .replace(/[,:;.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateInline(text, maxChars) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 1)}…`;
}

const gmailParsers = createGmailTextParsers({
  normalizeIntentText,
  extractQuotedSegments,
  normalizeRecipientName,
  truncateInline,
  gmailMaxResults: 20,
});

const gmailDeps = {
  normalizeIntentText,
  extractQuotedSegments,
  extractEmailAddresses: gmailParsers.extractEmailAddresses,
  extractRecipientNameFromText: gmailParsers.extractRecipientNameFromText,
  inferDefaultSelfEmailRecipient: () => "",
  detectGmailAutoContentKind: (textNormalized) => {
    if (/\b(s?ultim[oa]s?|noticias?|nove(?:dad(?:es)?|ades?)|actualidad|titulares?|news)\b/.test(textNormalized)) {
      return "news";
    }
    return undefined;
  },
  parseGmailLabeledFields: gmailParsers.parseGmailLabeledFields,
  extractLiteralBodyRequest: gmailParsers.extractLiteralBodyRequest,
  extractNaturalSubjectRequest: gmailParsers.extractNaturalSubjectRequest,
  detectCreativeEmailCue: gmailParsers.detectCreativeEmailCue,
  detectGmailDraftRequested: gmailParsers.detectGmailDraftRequested,
  buildGmailDraftInstruction: gmailParsers.buildGmailDraftInstruction,
  shouldAvoidLiteralBodyFallback: gmailParsers.shouldAvoidLiteralBodyFallback,
  parseNaturalLimit: gmailParsers.parseNaturalLimit,
  buildNaturalGmailQuery: gmailParsers.buildNaturalGmailQuery,
  gmailAccountEmail: "houdi@houdiagent.com",
};

function normalizeWorkspaceRelativePath(raw) {
  const value = String(raw).trim().replace(/^workspace\//i, "").replace(/^\/+/, "");
  if (!value) {
    return "";
  }
  return value
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .replace(/[,:;!?]+$/g, "")
    .trim();
}

function cleanWorkspacePathPhrase(raw) {
  const rawTrimmed = String(raw).trim();
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

function extractSimpleFilePathCandidate(text) {
  const token = String(text).match(/\b[\w./-]+\.[a-z0-9]{2,8}\b/i)?.[0] ?? "";
  return normalizeWorkspaceRelativePath(token);
}

const workspaceParsers = createWorkspaceTextParsers({
  normalizeIntentText,
  normalizeWorkspaceRelativePath,
  cleanWorkspacePathPhrase,
  extractQuotedSegments,
});

const workspaceDeps = {
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
  detectSimpleTextExtensionHint: (text) => detectSimpleTextExtensionHint(text, normalizeIntentText),
  resolveWorkspaceWritePathWithHint: (rawPath, extensionHint) => {
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
  looksLikeWorkspacePathCandidate: (raw) => looksLikeWorkspacePathCandidate(raw, normalizeWorkspaceRelativePath),
  parseWorkspaceFileIndexReference: (text) => parseWorkspaceFileIndexReference(text, normalizeIntentText),
};

function pct(ok, total) {
  if (!total) return "n/a";
  return `${((ok / total) * 100).toFixed(2)}%`;
}

function parseRow(line) {
  const row = JSON.parse(line);
  return {
    domain: String(row.domain || "").trim(),
    text: String(row.text || "").trim(),
    expectedShouldHandle: Boolean(row.expected_should_handle),
    expectedAction: row.expected_action ? String(row.expected_action) : null,
  };
}

function predict(domain, text) {
  if (domain === "gmail") {
    return detectGmailNaturalIntent(text, gmailDeps);
  }
  if (domain === "gmail-recipients") {
    return detectGmailRecipientNaturalIntent(text, gmailDeps);
  }
  if (domain === "workspace") {
    return detectWorkspaceNaturalIntent(text, workspaceDeps);
  }
  if (domain === "self-maintenance") {
    return detectSelfMaintenanceIntent(text);
  }
  return { shouldHandle: false };
}

async function main() {
  const raw = await fs.readFile(inputPath, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRow)
    .filter((row) => row.domain && row.text);

  const byDomain = new Map();
  for (const row of rows) {
    const predicted = predict(row.domain, row.text);
    const predictedHandle = Boolean(predicted?.shouldHandle);
    const predictedAction = predicted?.action ? String(predicted.action) : null;

    const slot = byDomain.get(row.domain) || {
      total: 0,
      fullOk: 0,
      handleOk: 0,
      actionTotal: 0,
      actionOk: 0,
      failures: [],
    };
    slot.total += 1;

    const handleOk = predictedHandle === row.expectedShouldHandle;
    if (handleOk) {
      slot.handleOk += 1;
    }

    let actionOk = true;
    if (row.expectedShouldHandle) {
      slot.actionTotal += 1;
      actionOk = predictedAction === row.expectedAction;
      if (actionOk) {
        slot.actionOk += 1;
      }
    }

    if (handleOk && actionOk) {
      slot.fullOk += 1;
    } else if (slot.failures.length < 20) {
      slot.failures.push({
        text: row.text,
        expectedHandle: row.expectedShouldHandle,
        predictedHandle,
        expectedAction: row.expectedAction,
        predictedAction,
      });
    }
    byDomain.set(row.domain, slot);
  }

  const domains = [...byDomain.keys()].sort();
  let globalTotal = 0;
  let globalOk = 0;
  console.log("Domain action-intents eval");
  console.log(`dataset: ${inputPath}`);
  console.log(`samples: ${rows.length}`);
  console.log("");
  for (const domain of domains) {
    const slot = byDomain.get(domain);
    if (!slot) continue;
    globalTotal += slot.total;
    globalOk += slot.fullOk;
    console.log(
      `- ${domain} | full=${pct(slot.fullOk, slot.total)} (${slot.fullOk}/${slot.total})` +
        ` | handle=${pct(slot.handleOk, slot.total)} (${slot.handleOk}/${slot.total})` +
        ` | action=${pct(slot.actionOk, slot.actionTotal)} (${slot.actionOk}/${slot.actionTotal})`,
    );
  }
  console.log("");
  console.log(`global_full_accuracy: ${pct(globalOk, globalTotal)} (${globalOk}/${globalTotal})`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`eval-domain-action-intents error: ${message}`);
  process.exitCode = 1;
});
