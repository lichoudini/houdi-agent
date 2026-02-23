export type WorkspaceNaturalIntent = {
  shouldHandle: boolean;
  action?: "list" | "mkdir" | "move" | "rename" | "copy" | "paste" | "delete" | "send" | "write" | "read";
  path?: string;
  sourcePath?: string;
  targetPath?: string;
  selector?: { mode: "startsWith" | "contains" | "exact"; value: string; scopePath?: string };
  deleteExtensions?: string[];
  deleteContentsOfPath?: string;
  append?: boolean;
  fileIndex?: number;
  content?: string;
  formatHint?: string;
};

type WorkspaceIntentDeps = {
  normalizeIntentText: (text: string) => string;
  extractQuotedSegments: (text: string) => string[];
  normalizeWorkspaceRelativePath: (raw: string) => string;
  cleanWorkspacePathPhrase: (raw: string) => string;
  extractSimpleFilePathCandidate: (text: string) => string;
  extractWorkspaceDeletePathCandidate: (text: string) => string;
  extractWorkspaceDeleteExtensions: (text: string) => string[];
  extractWorkspaceDeleteContentsPath: (text: string) => string;
  extractWorkspaceNameSelectorFromSegment: (params: {
    segment: string;
    defaultScopePath?: string;
    rawQuotedSegments: string[];
  }) => { mode: "startsWith" | "contains" | "exact"; value: string; scopePath?: string } | undefined;
  pickFirstNonEmpty: (...values: Array<string | undefined | null>) => string;
  detectSimpleTextExtensionHint: (text: string) => string | undefined;
  resolveWorkspaceWritePathWithHint: (rawPath: string, extensionHint?: string) => string;
  extractNaturalWorkspaceWriteContent: (params: {
    text: string;
    rawQuotedSegments: string[];
    selectedPath?: string;
  }) => string | undefined;
  looksLikeWorkspacePathCandidate: (raw: string) => boolean;
  parseWorkspaceFileIndexReference: (text: string) => number | null;
};

export function detectWorkspaceNaturalIntent(text: string, deps: WorkspaceIntentDeps): WorkspaceNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }
  const normalized = deps.normalizeIntentText(original);
  const hasWorkspaceWord = /\bworkspace\b/.test(normalized);
  const hasFileWord = /\b(archivo|archivos|documento|documentos|carpeta|carpetas|directorio|directorios|folder|folders)\b/.test(
    normalized,
  );
  const rawQuotedSegments = deps.extractQuotedSegments(original);
  const quoted = rawQuotedSegments.map((item) => deps.normalizeWorkspaceRelativePath(item)).filter(Boolean);
  const explicitWorkspacePath = deps.normalizeWorkspaceRelativePath(original.match(/\bworkspace\/([^\s"'`]+)/i)?.[1] ?? "");
  const fromFolderPhrase = deps.cleanWorkspacePathPhrase(
    original.match(/\b(?:carpeta|directorio|folder)\s+(.+)$/i)?.[1] ??
      original.match(/\b(?:en|dentro(?:\s+de)?|de)\s+(.+)$/i)?.[1] ??
      "",
  );
  const fromFilePhrase = deps.cleanWorkspacePathPhrase(
    original.match(
      /\b(?:archivo|archivos|documento|documentos|file|files|txt|csv|json|jsonl|md|yaml|yml|xml|html|htm|css|js|ini|log)\s+(?:llamado|de nombre)?\s*(.+)$/i,
    )?.[1] ?? "",
  );
  const explicitNamedPath = deps.cleanWorkspacePathPhrase(
    original.match(/\b(?:llamado|llamada|de nombre|nombre|(?:se\s+)?llam(?:e|ado|ada)?)\s+([^\s"'`]+)\b/i)?.[1] ?? "",
  );
  const fileLikePath = deps.extractSimpleFilePathCandidate(original);
  const hasCreateVerb =
    /\b(crea|crear|creame|creame|nuevo|nueva|nuevos|nuevas|genera|generar|generame|arma|armar|haz|hace|hacer)\b/.test(
      normalized,
    );
  const hasWriteVerb = /\b(escrib\w*|guard\w*|redact\w*|arm\w*)\b/.test(normalized);
  const hasEditVerb = /\b(edit\w*|modific\w*|actualiz\w*|complet\w*|agreg\w*|anex\w*|append|insert\w*)\b/.test(
    normalized,
  );
  const hasDrawVerb = /\b(dibuj\w*|traz\w*|ascii|ascci)\b/.test(normalized);
  const hasCopyMessageToFileCue =
    /\b(copiar|copia|copiame|copia?me|copia)\b/.test(normalized) &&
    /\b(mensaje|correo|mail|email)\b/.test(normalized) &&
    /\b(archivo|txt|csv|json|md|log)\b/.test(normalized);
  const hasCopyVerb = /\b(copiar|copia|duplicar|duplica|clonar|clona)\b/.test(normalized);
  const hasPasteVerb = /\b(pegar|pega|pegalo|pegala|paste)\b/.test(normalized);
  const hasSimpleFileKeyword = /\b(txt|csv|json|jsonl|md|yaml|yml|xml|html|htm|css|js|ini|log)\b/.test(normalized);
  const hasFolderWord = /\b(carpeta|directorio|folder)\b/.test(normalized);
  const hasReadVerb = /\b(ver|leer|lee|leelo|leela|mostrar|mostra|muestrame|muéstrame|mostrame|abrir|abre|abrilo|abrila)\b/.test(
    normalized,
  );
  const hasContentWord = /\b(contenido|texto|detalle|detalles)\b/.test(normalized);
  const hasDeleteVerb = /\b(eliminar|elimina|borrar|borra|quitar|quita|suprimir|suprime|remove|delete)\b/.test(normalized);
  const hasMailContext = /\b(correo|correos|mail|mails|email|emails|gmail|inbox|bandeja)\b/.test(normalized);
  const hasSendVerb =
    /\b(enviar|envia|enviame|enviame|mandar|manda|mandame|pasar|pasa|compartir|comparte|adjuntar|adjunta|subir|sube)\b/.test(
      normalized,
    );
  const hasSendNoun = /\b(archivo|archivos|documento|documentos|file|files|pdf|imagen|imagenes|foto|fotos)\b/.test(
    normalized,
  );
  const extractExplicitPathHint = (rawSegment: string): string => {
    const cleaned = deps.cleanWorkspacePathPhrase(rawSegment);
    if (!cleaned) {
      return "";
    }
    const singleToken = cleaned.split(/\s+/).filter(Boolean);
    if (singleToken.length !== 1) {
      return "";
    }
    const token = singleToken[0] ?? "";
    if (/@/.test(token)) {
      return "";
    }
    if (token.includes("/")) {
      return token;
    }
    if (/\.{2,}/.test(token)) {
      return token;
    }
    if (/\.[a-z0-9]{1,12}$/i.test(token)) {
      return token;
    }
    return "";
  };
  const hasFileLikeToken = /\b[\w./\\-]+\.[a-z0-9]{2,8}\b/i.test(original);
  const defaultSelectorScope = deps.pickFirstNonEmpty(explicitWorkspacePath, fromFolderPhrase);
  const hasWorkspaceFileContext =
    hasWorkspaceWord || hasFileWord || hasFileLikeToken || quoted.length > 0 || Boolean(explicitWorkspacePath);
  const readPhraseMatch = original.match(/\b(?:ver|leer|lee|mostrar|mostra|muestrame|muéstrame|mostrame|abrir|abre)\s+(.+)$/i);
  const readPathHintRaw = deps.pickFirstNonEmpty(
    quoted[0],
    explicitWorkspacePath,
    explicitNamedPath,
    fileLikePath,
    fromFilePhrase,
    deps.cleanWorkspacePathPhrase(readPhraseMatch?.[1] ?? ""),
  );
  const readPathHintNormalized = deps.normalizeIntentText(readPathHintRaw);
  const readPathHintIsPlaceholder =
    /^(?:el|la|los|las)?\s*(?:contenido|texto|detalle|detalles)(?:\s+de(?:l)?\s+(?:archivo|documento))?$/.test(
      readPathHintNormalized,
    );
  const readPathHint = readPathHintIsPlaceholder ? "" : readPathHintRaw;
  const hasListPluralCue = /\b(archivos|carpetas|directorios|folders)\b/.test(normalized);
  const allowPathlessRead = hasReadVerb && hasContentWord;
  const deletePhraseMatch = original.match(
    /\b(?:elimin[\p{L}\d_]*|borr[\p{L}\d_]*|quit[\p{L}\d_]*|suprim[\p{L}\d_]*|delete|remove)\s+(.+)$/iu,
  );
  const deletePhrase = deletePhraseMatch?.[1] ?? "";
  const deletePathCandidate = deps.extractWorkspaceDeletePathCandidate(deletePhrase);
  const explicitDeletePathHint = extractExplicitPathHint(deletePhrase);
  const deleteExtensions = deps.extractWorkspaceDeleteExtensions(deletePhrase || original);
  const deleteContentsOfPath = deps.extractWorkspaceDeleteContentsPath(deletePhrase || original);
  const hasExplicitContentMarker =
    /\b(?:con(?:tenido)?|contenido|texto|body|data|datos)\s*(?::|=)\s*/i.test(original) ||
    rawQuotedSegments.length >= 2 ||
    /\n/.test(original);
  const editPathMatch = original.match(/\b(?:editar|modific\w*|actualiz\w*|complet\w*|agreg\w*|anex\w*)\s+([^\s"'`]+)/i);
  const inPathWriteMatch = original.match(
    /\b(?:en|dentro(?:\s+de)?)\s+(?:el\s+)?(?:archivo|documento)?\s*([^\s"'`]+)\s+(?:escrib\w*|redact\w*|guard\w*|agreg\w*|anex\w*)\b/i,
  );
  const explicitWritePathHint = deps.pickFirstNonEmpty(
    extractExplicitPathHint(editPathMatch?.[1] ?? ""),
    extractExplicitPathHint(inPathWriteMatch?.[1] ?? ""),
  );
  const writeInlineContentHint = deps.pickFirstNonEmpty(
    original.match(/\b(?:editar|modific\w*|actualiz\w*|complet\w*|agreg\w*|anex\w*)\s+[^\s"'`]+\s+con\s+(.+)$/i)?.[1],
    original.match(
      /\b(?:en|dentro(?:\s+de)?)\s+(?:el\s+)?(?:archivo|documento)?\s*[^\s"'`]+\s+(?:escrib\w*|redact\w*|guard\w*|agreg\w*|anex\w*)\s+(.+)$/i,
    )?.[1],
  );
  const writeTargetHint = deps.pickFirstNonEmpty(
    quoted[0],
    explicitWorkspacePath,
    explicitWritePathHint,
    explicitNamedPath,
    fileLikePath,
    fromFilePhrase,
  );
  const resolveWriteTargetPath = (rawTargetPath: string, extensionHint?: string): string => {
    const hinted = deps.resolveWorkspaceWritePathWithHint(rawTargetPath, extensionHint);
    if (hinted) {
      return hinted;
    }
    const normalizedTarget = deps.normalizeWorkspaceRelativePath(rawTargetPath);
    if (!normalizedTarget) {
      return "";
    }
    // Keep fuzzy placeholders (eg: "mag..") so runtime autocompletion can resolve
    // to an existing workspace file instead of forcing an auto-generated filename.
    if (/\.{2,}$/.test(normalizedTarget) || deps.looksLikeWorkspacePathCandidate(normalizedTarget)) {
      return normalizedTarget;
    }
    return "";
  };
  const shouldPrioritizeWrite =
    Boolean(writeTargetHint) &&
    (hasWriteVerb || hasEditVerb || hasDrawVerb || /\b(?:en|dentro(?:\s+de)?)\s+(?:el\s+)?archivo\b/.test(normalized)) &&
    (hasExplicitContentMarker || Boolean(writeInlineContentHint));

  if (shouldPrioritizeWrite) {
    const formatHint = deps.detectSimpleTextExtensionHint(original);
    const targetPath = resolveWriteTargetPath(writeTargetHint, formatHint);
    const content = deps.extractNaturalWorkspaceWriteContent({
      text: original,
      rawQuotedSegments,
      selectedPath: targetPath,
    });
    const resolvedContent = deps.pickFirstNonEmpty(content, writeInlineContentHint);
    const append =
      /\b(al\s+final|append|anex\w*|agreg\w*)\b/.test(normalized) &&
      !/\b(reemplaz\w*|sobrescrib\w*)\b/.test(normalized);
    return {
      shouldHandle: true,
      action: "write",
      ...(targetPath ? { path: targetPath } : {}),
      ...(typeof resolvedContent === "string" ? { content: resolvedContent } : {}),
      ...(append ? { append: true } : {}),
      ...(formatHint ? { formatHint } : {}),
    };
  }

  if (
    hasDeleteVerb &&
    (hasWorkspaceWord ||
      hasFileWord ||
      hasFileLikeToken ||
      Boolean(fileLikePath) ||
      Boolean(explicitWorkspacePath) ||
      quoted.length > 0 ||
      /\bl[oa]s?\b/.test(normalized) ||
      Boolean(deletePathCandidate) ||
      Boolean(explicitDeletePathHint))
  ) {
    if (deleteContentsOfPath) {
      return {
        shouldHandle: true,
        action: "delete",
        deleteContentsOfPath,
      };
    }

    if (deleteExtensions.length > 0) {
      return {
        shouldHandle: true,
        action: "delete",
        deleteExtensions,
        ...(defaultSelectorScope ? { path: defaultSelectorScope } : {}),
      };
    }

    const selector = deps.extractWorkspaceNameSelectorFromSegment({
      segment: deletePhrase || original,
      defaultScopePath: defaultSelectorScope,
      rawQuotedSegments,
    });
    const strictDeleteCandidate = extractExplicitPathHint(deletePathCandidate);
    const targetPath = deps.pickFirstNonEmpty(quoted[0], explicitWorkspacePath, explicitDeletePathHint, strictDeleteCandidate);
    return {
      shouldHandle: true,
      action: "delete",
      ...(targetPath ? { path: targetPath } : {}),
      ...(selector ? { selector } : {}),
    };
  }

  const renameIntent =
    /\b(renombr\w*|rename)\b/.test(normalized) ||
    (/\b(cambiar|cambia|cambiarle|cambiale)\b/.test(normalized) && /\b(nombre)\b/.test(normalized)) ||
    /\b(cambiar|cambia)\s+([^\s"'`]+)\s+(?:a|por|como)\s+([^\s"'`]+)/.test(normalized);
  if (renameIntent) {
    const phraseMatch =
      original.match(/\b(?:renombr\w*|rename|cambiar\s+nombre(?:\s+de)?|cambia(?:r)?)\s+(.+?)\s+(?:a|por|como)\s+(.+)$/i) ??
      null;
    const sourcePath = quoted[0] ?? deps.cleanWorkspacePathPhrase(phraseMatch?.[1] ?? "");
    const targetPath = quoted[1] ?? deps.cleanWorkspacePathPhrase(phraseMatch?.[2] ?? "");
    return {
      shouldHandle: true,
      action: "rename",
      ...(sourcePath ? { sourcePath } : {}),
      ...(targetPath ? { targetPath } : {}),
    };
  }

  const moveIntent =
    /\b(mover|mueve|movan|movelo|movela|move)\b/.test(normalized) ||
    /\b(trasladar|traslada|trasladen|trasladalo|trasladala)\b/.test(normalized);
  if (moveIntent) {
    const phraseMatch = original.match(
      /\b(?:mover|mueve|movan|movelo|movela|move|trasladar|traslada|trasladen|trasladalo|trasladala)\s+(.+?)\s+(?:a|hacia)\s+(.+)$/i,
    );
    const sourceSegment = phraseMatch?.[1] ?? "";
    const selector = deps.extractWorkspaceNameSelectorFromSegment({
      segment: sourceSegment || original,
      defaultScopePath: defaultSelectorScope,
      rawQuotedSegments,
    });
    const sourcePath = quoted[0] ?? deps.cleanWorkspacePathPhrase(sourceSegment);
    const targetPath = quoted[1] ?? deps.cleanWorkspacePathPhrase(phraseMatch?.[2] ?? "");
    return {
      shouldHandle: true,
      action: "move",
      ...(sourcePath ? { sourcePath } : {}),
      ...(targetPath ? { targetPath } : {}),
      ...(selector ? { selector } : {}),
    };
  }

  const hasRenameOrMoveVerb = renameIntent || moveIntent;
  const writeIntent =
    ((hasCreateVerb || hasWriteVerb || hasEditVerb || hasDrawVerb) &&
      !hasFolderWord &&
      !hasRenameOrMoveVerb &&
      (hasFileWord || hasSimpleFileKeyword || Boolean(fileLikePath))) ||
    ((hasCreateVerb || hasEditVerb || hasDrawVerb) && Boolean(fileLikePath)) ||
    (hasCopyMessageToFileCue && Boolean(fileLikePath));
  if (writeIntent) {
    const formatHint = deps.detectSimpleTextExtensionHint(original);
    const rawTargetPath = deps.pickFirstNonEmpty(quoted[0], explicitWorkspacePath, explicitNamedPath, fileLikePath, fromFilePhrase);
    const targetPath = resolveWriteTargetPath(rawTargetPath, formatHint);
    const content = deps.extractNaturalWorkspaceWriteContent({
      text: original,
      rawQuotedSegments,
      selectedPath: targetPath,
    });
    const resolvedContent = deps.pickFirstNonEmpty(content, writeInlineContentHint);
    const append =
      /\b(al\s+final|append|anex\w*|agreg\w*)\b/.test(normalized) &&
      !/\b(reemplaz\w*|sobrescrib\w*)\b/.test(normalized);
    return {
      shouldHandle: true,
      action: "write",
      ...(targetPath ? { path: targetPath } : {}),
      ...(typeof resolvedContent === "string" ? { content: resolvedContent } : {}),
      ...(append ? { append: true } : {}),
      ...(formatHint ? { formatHint } : {}),
    };
  }

  const readIntent = (hasReadVerb || hasContentWord) && !hasListPluralCue && (Boolean(readPathHint) || allowPathlessRead);
  if (readIntent) {
    return {
      shouldHandle: true,
      action: "read",
      ...(readPathHint ? { path: readPathHint } : {}),
    };
  }

  const listVerb =
    /\b(lista\w*|mostr\w*|ver|revis\w*|explor\w*)\b/.test(normalized) ||
    /\bcontenido\s+de\b/.test(normalized) ||
    /\bver\s+contenido\b/.test(normalized) ||
    /\bmostrar\s+contenido\b/.test(normalized) ||
    normalized.includes("que hay") ||
    normalized.includes("que tengo");
  if (listVerb && (hasWorkspaceWord || hasFileWord)) {
    const inferredPath = quoted[0] || explicitWorkspacePath || fromFolderPhrase;
    return {
      shouldHandle: true,
      action: "list",
      ...(inferredPath ? { path: inferredPath } : {}),
    };
  }

  const mkdirIntent = hasCreateVerb && hasFolderWord;
  if (mkdirIntent) {
    const fromPhrase = original.match(/\b(?:carpeta|directorio|folder)\s+(?:llamada|de nombre)?\s*(.+)$/i)?.[1] ?? "";
    const dirPath = quoted[0] ?? deps.cleanWorkspacePathPhrase(fromPhrase);
    return {
      shouldHandle: true,
      action: "mkdir",
      ...(dirPath ? { path: dirPath } : {}),
    };
  }

  if (hasCopyVerb) {
    const phraseMatch = original.match(/\b(?:copiar|copia|duplicar|duplica|clonar|clona)\s+(.+?)(?:\s+(?:a|hacia)\s+(.+))?$/iu);
    const sourceSegment = phraseMatch?.[1] ?? original;
    const selector = deps.extractWorkspaceNameSelectorFromSegment({
      segment: sourceSegment,
      defaultScopePath: defaultSelectorScope,
      rawQuotedSegments,
    });
    const sourcePath = quoted[0] ?? deps.cleanWorkspacePathPhrase(sourceSegment);
    const targetPath = quoted[1] ?? deps.cleanWorkspacePathPhrase(phraseMatch?.[2] ?? "");
    const hasPathHints = deps.looksLikeWorkspacePathCandidate(sourcePath) || deps.looksLikeWorkspacePathCandidate(targetPath);
    if (selector || hasWorkspaceFileContext || hasPathHints) {
      return {
        shouldHandle: true,
        action: "copy",
        ...(sourcePath ? { sourcePath } : {}),
        ...(targetPath ? { targetPath } : {}),
        ...(selector ? { selector } : {}),
      };
    }
  }

  if (hasPasteVerb && (hasWorkspaceFileContext || /\b(portapapeles|clipboard)\b/.test(normalized))) {
    const phraseMatch = original.match(/\b(?:pegar|pega|pegalo|pegala|paste)\s+(?:en|a|hacia)?\s*(.+)$/iu);
    const targetPath = quoted[0] ?? explicitWorkspacePath ?? deps.cleanWorkspacePathPhrase(phraseMatch?.[1] ?? "");
    return {
      shouldHandle: true,
      action: "paste",
      ...(targetPath ? { targetPath } : {}),
    };
  }

  if (
    hasSendVerb &&
    !hasMailContext &&
    (hasSendNoun ||
      hasFileLikeToken ||
      hasWorkspaceWord ||
      quoted.length > 0 ||
      Boolean(explicitWorkspacePath) ||
      Boolean(extractExplicitPathHint(original.match(
        /\b(?:enviar|envia|enviame|enviame|mandar|manda|mandame|pasar|pasa|compartir|comparte|adjuntar|adjunta|subir|sube)\s+(.+)$/iu,
      )?.[1] ?? "")))
  ) {
    const phraseMatch = original.match(
      /\b(?:enviar|envia|enviame|enviame|mandar|manda|mandame|pasar|pasa|compartir|comparte|adjuntar|adjunta|subir|sube)\s+(.+)$/iu,
    );
    const fileIndex = deps.parseWorkspaceFileIndexReference(original) ?? undefined;
    const explicitSendPathHint = extractExplicitPathHint(phraseMatch?.[1] ?? "");
    const targetPath = deps.pickFirstNonEmpty(
      quoted[0],
      explicitWorkspacePath,
      explicitSendPathHint,
    );
    return {
      shouldHandle: true,
      action: "send",
      ...(targetPath ? { path: targetPath } : {}),
      ...(fileIndex ? { fileIndex } : {}),
    };
  }

  return { shouldHandle: false };
}
