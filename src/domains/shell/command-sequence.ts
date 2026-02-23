export function splitExecSequenceInput(rawInput: string): string[] {
  const source = rawInput.trim();
  if (!source) {
    return [];
  }
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      const cleaned = current.trim();
      if (cleaned) {
        out.push(cleaned);
      }
      current = "";
      continue;
    }
    if (ch === "&" && next === "&") {
      const cleaned = current.trim();
      if (cleaned) {
        out.push(cleaned);
      }
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) {
    out.push(tail);
  }
  return out;
}

export function normalizeExecCommandSequence(rawInput: string, maxItems = 12): string[] {
  return splitExecSequenceInput(rawInput)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Math.floor(maxItems)));
}
