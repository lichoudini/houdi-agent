#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repoRoot = process.cwd();

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function listTrackedFiles() {
  const output = git(["ls-files"]);
  if (!output) {
    return [];
  }
  return output.split("\n").map((item) => item.trim()).filter(Boolean);
}

function isTextFile(buffer) {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let index = 0; index < sampleSize; index += 1) {
    if (buffer[index] === 0) {
      return false;
    }
  }
  return true;
}

function stripEnclosingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isPlaceholderValue(rawValue) {
  const value = stripEnclosingQuotes(rawValue.trim());
  if (!value) {
    return true;
  }
  if (value === "__REDACTED__") {
    return true;
  }
  if (value.includes("...")) {
    return true;
  }
  if (value.includes("<") && value.includes(">")) {
    return true;
  }
  if (value.toLowerCase().includes("replace_me")) {
    return true;
  }
  return false;
}

const forbiddenPathRules = [
  {
    id: "path.env",
    message: "No versionar archivos .env reales o backups.",
    test: (file) => file === ".env" || (/\.env\./i.test(file) && file !== ".env.example"),
  },
  {
    id: "path.logs",
    message: "No versionar logs/runtime DB.",
    test: (file) => /\.(log|sqlite|db)$/i.test(file),
  },
  {
    id: "path.datasets",
    message: "No versionar datasets internos del proyecto.",
    test: (file) => /^datasets\//i.test(file),
  },
  {
    id: "path.experiments",
    message: "No versionar tools/experiments internos.",
    test: (file) => /^tools\/experiments\//i.test(file),
  },
];

const blockedInternalWord = String.fromCharCode(108, 105, 109);

const forbiddenLineRules = [
  {
    id: "content.restricted-internal-reference",
    message: "No incluir referencias internas restringidas en el repositorio público.",
    regex: new RegExp(`\\b${blockedInternalWord}\\b|\\/${blockedInternalWord}\\b|${blockedInternalWord}-`, "i"),
  },
];

const directSecretRegexes = [
  { id: "secret.openai", regex: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { id: "secret.slack-bot", regex: /\bxoxb-[A-Za-z0-9-]{20,}\b/ },
  { id: "secret.slack-app", regex: /\bxapp-[A-Za-z0-9-]{20,}\b/ },
  { id: "secret.telegram", regex: /\b\d{7,12}:[A-Za-z0-9_-]{20,}\b/ },
  { id: "secret.github", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: "secret.aws", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "secret.google", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const sensitiveEnvKeys = new Set([
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "HOUDI_LOCAL_API_TOKEN",
]);

const trackedFiles = listTrackedFiles();
const findings = [];

for (const file of trackedFiles) {
  for (const rule of forbiddenPathRules) {
    if (rule.test(file)) {
      findings.push({
        type: rule.id,
        file,
        line: 1,
        detail: rule.message,
      });
    }
  }
}

for (const file of trackedFiles) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (!isTextFile(buffer)) {
    continue;
  }
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  const skipTokenHeuristics = file === "package-lock.json";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const rule of forbiddenLineRules) {
      if (rule.regex.test(line)) {
        findings.push({
          type: rule.id,
          file,
          line: lineNumber,
          detail: rule.message,
        });
      }
    }

    if (!skipTokenHeuristics) {
      for (const secretRule of directSecretRegexes) {
        if (secretRule.regex.test(line)) {
          findings.push({
            type: secretRule.id,
            file,
            line: lineNumber,
            detail: "Posible secreto hardcodeado detectado.",
          });
        }
      }
    }

    const envMatch = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (envMatch) {
      const key = envMatch[1];
      const value = envMatch[2] ?? "";
      if (sensitiveEnvKeys.has(key) && !isPlaceholderValue(value)) {
        findings.push({
          type: "secret.env-assignment",
          file,
          line: lineNumber,
          detail: `Valor sensible detectado para ${key}.`,
        });
      }
    }
  }
}

if (findings.length > 0) {
  const lines = [];
  lines.push("repo-guard: FAIL");
  lines.push("Se detectaron incumplimientos de publicación segura:");
  for (const finding of findings) {
    lines.push(`- [${finding.type}] ${finding.file}:${finding.line} -> ${finding.detail}`);
  }
  lines.push("");
  lines.push("Acción sugerida:");
  lines.push("1. Quitar/anonimizar secretos y datos privados.");
  lines.push("2. Eliminar referencias internas restringidas.");
  lines.push("3. Sacar logs, datasets o artifacts internos del commit.");
  console.error(lines.join("\n"));
  process.exit(1);
}

console.log(`repo-guard: OK (${trackedFiles.length} archivos revisados)`);
