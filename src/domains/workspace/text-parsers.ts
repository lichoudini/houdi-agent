type WorkspaceTextParsersOptions = {
  normalizeIntentText: (text: string) => string;
  normalizeWorkspaceRelativePath: (raw: string) => string;
  cleanWorkspacePathPhrase: (raw: string) => string;
  extractQuotedSegments: (text: string) => string[];
};

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^(["'`])(.*)\1$/, "$2").trim();
}

export function createWorkspaceTextParsers(options: WorkspaceTextParsersOptions) {
  const { normalizeIntentText, normalizeWorkspaceRelativePath, cleanWorkspacePathPhrase, extractQuotedSegments } = options;

  function extractWorkspaceNameSelectorFromSegment(params: {
    segment: string;
    defaultScopePath?: string;
    rawQuotedSegments: string[];
  }): { mode: "startsWith" | "contains" | "exact"; value: string; scopePath?: string } | undefined {
    const segment = params.segment ?? "";
    const normalized = normalizeIntentText(segment);
    const quoted = params.rawQuotedSegments?.length > 0 ? params.rawQuotedSegments : extractQuotedSegments(segment);
    const value = stripOuterQuotes(quoted[0] ?? "");
    if (!value) {
      return undefined;
    }
    if (/\b(empiez|arranc|inici)\w*\b/.test(normalized)) {
      return {
        mode: "startsWith",
        value,
        ...(params.defaultScopePath ? { scopePath: normalizeWorkspaceRelativePath(params.defaultScopePath) } : {}),
      };
    }
    if (/\b(contien|incluy)\w*\b/.test(normalized)) {
      return {
        mode: "contains",
        value,
        ...(params.defaultScopePath ? { scopePath: normalizeWorkspaceRelativePath(params.defaultScopePath) } : {}),
      };
    }
    return {
      mode: "exact",
      value,
      ...(params.defaultScopePath ? { scopePath: normalizeWorkspaceRelativePath(params.defaultScopePath) } : {}),
    };
  }

  function extractWorkspaceDeletePathCandidate(text: string): string {
    const quoted = extractQuotedSegments(text);
    const firstQuoted = quoted[0]?.trim();
    if (firstQuoted) {
      return normalizeWorkspaceRelativePath(cleanWorkspacePathPhrase(firstQuoted));
    }

    const match = text.match(/\b(?:elimina|eliminar|borra|borrar|quita|quitar)\b\s+(.+)$/i);
    const candidate = cleanWorkspacePathPhrase(match?.[1] ?? "").trim();
    if (!candidate) {
      return "";
    }
    return normalizeWorkspaceRelativePath(candidate);
  }

  function extractWorkspaceDeleteExtensions(text: string): string[] {
    const normalized = normalizeIntentText(text);
    const hits = Array.from(normalized.matchAll(/\.([a-z0-9]{1,12})\b/g)).map((m) => `.${(m[1] ?? "").toLowerCase()}`);
    return Array.from(new Set(hits));
  }

  function extractWorkspaceDeleteContentsPath(text: string): string {
    const match = text.match(/\b(?:contenido|contenidos)\s+de\s+(.+)$/i);
    const candidate = cleanWorkspacePathPhrase(match?.[1] ?? "").trim();
    if (!candidate) {
      return "";
    }
    return normalizeWorkspaceRelativePath(candidate);
  }

  function decodeEscapedInlineText(text: string): string {
    return text
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }

  function extractNaturalWorkspaceWriteContent(params: {
    text: string;
    rawQuotedSegments: string[];
    selectedPath?: string;
  }): string | undefined {
    const text = params.text ?? "";
    const quoted = params.rawQuotedSegments?.length > 0 ? params.rawQuotedSegments : extractQuotedSegments(text);
    if (quoted.length > 0) {
      const lastQuoted = stripOuterQuotes(quoted[quoted.length - 1] ?? "");
      const selectedPath = stripOuterQuotes(params.selectedPath ?? "");
      if (!selectedPath || normalizeWorkspaceRelativePath(lastQuoted) !== normalizeWorkspaceRelativePath(selectedPath)) {
        return decodeEscapedInlineText(lastQuoted);
      }
    }

    const delimiters = ["que contenga", "contenido:", "contenido", "con:", "con "];
    for (const delimiter of delimiters) {
      const idx = normalizeIntentText(text).indexOf(delimiter);
      if (idx >= 0) {
        const chunk = text.slice(idx + delimiter.length).trim();
        if (chunk) {
          return decodeEscapedInlineText(chunk);
        }
      }
    }
    return undefined;
  }

  return {
    extractWorkspaceNameSelectorFromSegment,
    extractWorkspaceDeletePathCandidate,
    extractWorkspaceDeleteExtensions,
    extractWorkspaceDeleteContentsPath,
    decodeEscapedInlineText,
    extractNaturalWorkspaceWriteContent,
  };
}
