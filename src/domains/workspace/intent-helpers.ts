export function pickFirstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

export function parseWorkspaceFileIndexReference(
  text: string,
  normalizeIntentText: (text: string) => string,
): number | null {
  const normalized = normalizeIntentText(text);
  const match = normalized.match(/(?:archivo|item|resultado|opcion|opción)?\s*(\d{1,3})\b/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

export function detectSimpleTextExtensionHint(
  text: string,
  normalizeIntentText: (text: string) => string,
): string | undefined {
  const normalized = normalizeIntentText(text);
  const tokens = ["txt", "md", "json", "csv", "jsonl", "log", "yaml", "yml", "xml", "html", "css", "js", "ini"];
  for (const token of tokens) {
    const regex = new RegExp(`\\b${token}\\b`, "i");
    if (regex.test(normalized)) {
      return `.${token}`;
    }
  }
  return undefined;
}

export function looksLikeWorkspacePathCandidate(
  raw: string,
  normalizeWorkspaceRelativePath: (raw: string) => string,
): boolean {
  const normalized = normalizeWorkspaceRelativePath(raw);
  if (!normalized) {
    return false;
  }
  if (normalized.includes("/")) {
    return true;
  }
  return /\.[a-z0-9]{1,12}$/i.test(normalized);
}
