import type { PromptMemoryHit } from "./agent-context-memory.js";

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = " [...truncated]";
  const usable = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, usable)}${marker}`;
}

function humanizeFactKey(rawKey: string): string {
  return rawKey.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function stripMemoryMetadata(raw: string): string {
  const parts = raw.split(/\s+\|\s+/);
  if (parts.length === 1) {
    return raw;
  }
  const kept: string[] = [];
  for (const part of parts) {
    const normalized = part.trim();
    if (!normalized) {
      continue;
    }
    if (/^(meta=|updated=|source=|chat=|user=|role=)/i.test(normalized)) {
      break;
    }
    kept.push(normalized);
  }
  return kept.length > 0 ? kept.join(" | ") : parts[0] ?? "";
}

function sanitizeMemorySnippet(snippetInput: string): string {
  let text = snippetInput.trim();
  if (!text) {
    return "";
  }

  text = stripMemoryMetadata(text);
  text = text
    .replace(/^\s*[-*]\s*\[(\d{2}:\d{2}:\d{2})\]\s*(USER|ASSISTANT):\s*/i, "")
    .replace(/^\s*\[(WEBASK|WEBOPEN|ASKFILE)\]\s*/i, "")
    .replace(/^\s*(USER|ASSISTANT):\s*/i, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  const factMatch = text.match(/^([a-z0-9_]{2,80})\s*:\s*(.+)$/i);
  if (factMatch) {
    const key = humanizeFactKey((factMatch[1] ?? "").trim());
    const value = (factMatch[2] ?? "").trim();
    if (key && value) {
      text = `${key}: ${value}`;
    }
  }

  return truncateInline(text, 280);
}

function describeMemorySource(pathInput: string): string {
  const normalized = pathInput.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  if (lower === "memory.md") {
    return "memoria de largo plazo";
  }
  if (lower.endsWith("/continuity.md")) {
    return "continuidad del chat";
  }
  if (/^memory\/chats\/chat-\d+\//.test(lower)) {
    return "historial conversacional";
  }
  if (lower.startsWith("memory/")) {
    return "memoria diaria";
  }
  return "archivo de memoria";
}

function formatMemoryHitSource(hit: PromptMemoryHit): string {
  const normalizedPath = hit.path.replace(/\\/g, "/");
  const sourceType = describeMemorySource(normalizedPath);
  return `${sourceType} (${normalizedPath}#L${hit.line})`;
}

export function formatMemoryHitsNaturalText(params: {
  query: string;
  hits: PromptMemoryHit[];
  intro?: string;
  maxItems?: number;
  followUpHint?: string;
}): string {
  const maxItems = Math.max(1, Math.floor(params.maxItems ?? params.hits.length));
  const selected = params.hits.slice(0, maxItems);
  const intro = params.intro?.trim() || `Esto recuerdo sobre "${params.query}":`;
  const blocks = selected.map((hit, index) => {
    const snippet = sanitizeMemorySnippet(hit.snippet) || "(sin texto util)";
    return `${index + 1}. ${snippet}\n   Fuente: ${formatMemoryHitSource(hit)}`;
  });
  const followUpHint = params.followUpHint?.trim();
  return [intro, ...blocks, ...(followUpHint ? [followUpHint] : [])].join("\n\n");
}
