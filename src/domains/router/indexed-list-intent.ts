export type IndexedListAction = "open" | "read" | "delete";

export type IndexedListReferenceIntent = {
  shouldHandle: boolean;
  action?: IndexedListAction;
  indexes: number[];
  selectAll?: boolean;
  selectLast?: boolean;
  selectPenultimate?: boolean;
};

export function parseIndexedListReferenceIntent(
  text: string,
  normalizeIntentText: (text: string) => string,
): IndexedListReferenceIntent {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return { shouldHandle: false, indexes: [] };
  }

  const action: IndexedListAction | undefined = /\b(elimina|eliminar|borra|borrar|quita|quitar|suprime|suprimir|remueve|remover|delete|remove)\b/.test(
    normalized,
  )
    ? "delete"
    : /\b(lee|leer|leyendo|revisa|revisa|analiza|analizar)\b/.test(normalized)
      ? "read"
      : /\b(abre|abrir|abri|abr[ií]|mostrar|mostra|ver)\b/.test(normalized)
        ? "open"
        : undefined;
  if (!action) {
    return { shouldHandle: false, indexes: [] };
  }

  const indexes = new Set<number>();
  const addIndex = (value: number) => {
    if (Number.isFinite(value) && value > 0 && value <= 999) {
      indexes.add(Math.floor(value));
    }
  };

  for (const match of normalized.matchAll(/\b(\d{1,3})\s*(?:al|-|a)\s*(\d{1,3})\b/g)) {
    const start = Number.parseInt(match[1] ?? "", 10);
    const end = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    for (let current = min; current <= max && current - min < 20; current += 1) {
      addIndex(current);
    }
  }
  for (const match of normalized.matchAll(/\b(\d{1,3})\b/g)) {
    addIndex(Number.parseInt(match[1] ?? "", 10));
  }
  if (/\b(primer[oa]?|primero|primera)\b/.test(normalized)) {
    addIndex(1);
  }
  const ordinalWords: Array<{ regex: RegExp; value: number }> = [
    { regex: /\b(segund[oa]?|segundo|segunda)\b/, value: 2 },
    { regex: /\b(tercer[oa]?|tercero|tercera)\b/, value: 3 },
    { regex: /\b(cuart[oa]?|cuarto|cuarta)\b/, value: 4 },
    { regex: /\b(quint[oa]?|quinto|quinta)\b/, value: 5 },
    { regex: /\b(sext[oa]?|sexto|sexta)\b/, value: 6 },
    { regex: /\b(septim[oa]?|septimo|septima|s[eé]ptim[oa]?|s[eé]ptimo|s[eé]ptima)\b/, value: 7 },
    { regex: /\b(octav[oa]?|octavo|octava)\b/, value: 8 },
    { regex: /\b(noven[oa]?|noveno|novena)\b/, value: 9 },
    { regex: /\b(decim[oa]?|decimo|decima|d[eé]cim[oa]?|d[eé]cimo|d[eé]cima)\b/, value: 10 },
  ];
  for (const ordinal of ordinalWords) {
    if (ordinal.regex.test(normalized)) {
      addIndex(ordinal.value);
    }
  }

  const selectLast = /\b(ultim[oa]?|ultimo|ultima|el ultimo|la ultima)\b/.test(normalized);
  const selectPenultimate = /\b(penultim[oa]?|penultimo|penultima|anteultim[oa]?|anteultimo|anteultima)\b/.test(
    normalized,
  );
  const selectAll = /\b(todos?|todas?)\b/.test(normalized);

  return {
    shouldHandle: indexes.size > 0 || selectAll || selectLast || selectPenultimate,
    action,
    indexes: Array.from(indexes).sort((a, b) => a - b),
    selectAll,
    selectLast,
    selectPenultimate,
  };
}
