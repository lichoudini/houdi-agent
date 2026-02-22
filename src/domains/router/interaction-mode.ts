export type InteractionMode = "operational" | "conversational" | "mixed";

function hasOperationalVerb(normalizedText: string): boolean {
  return /\b(crea|crear|arma|guardar|guarda|envia|enviar|manda|mandar|revisa|revisar|busca|buscar|lista|listar|muestra|mostrar|programa|programar|elimina|eliminar|borra|borrar|mueve|mover|copia|copiar|pega|pegar|renombra|renombrar|lee|leer)\b/.test(
    normalizedText,
  );
}

function hasOperationalNoun(normalizedText: string): boolean {
  return /\b(workspace|archivo|carpeta|correo|gmail|email|mail|recordatorio|tarea|lim|web|internet|noticia|noticias|documento|pdf|csv|json|html|skill|habilidad|regla)\b/.test(
    normalizedText,
  );
}

function hasNarrativeCue(normalizedText: string): boolean {
  const hasFirstPersonCue = /\b(yo|me|mi|mis|conmigo|nos|nosotros|nosotras)\b/.test(normalizedText);
  const hasNarrativeVerb =
    /\b(tuve|fui|estuve|comi|almorce|merende|cene|sali|volvi|dormi|descanse|camine|viaje|trabaje|charle|hable|disfrute|me senti|me dormi)\b/.test(
      normalizedText,
    ) || /\bla pase\b/.test(normalizedText);
  const hasNarrativeTimeCue = /\b(hoy|ayer|anoche|esta manana|esta tarde|esta noche|recien)\b/.test(normalizedText);
  return (hasFirstPersonCue && hasNarrativeVerb) || (hasNarrativeTimeCue && hasNarrativeVerb);
}

export function classifyInteractionMode(normalizedTextInput: string): InteractionMode {
  const normalizedText = normalizedTextInput.trim();
  if (!normalizedText) {
    return "mixed";
  }

  const operational = hasOperationalVerb(normalizedText) || hasOperationalNoun(normalizedText);
  const conversational = hasNarrativeCue(normalizedText);

  if (operational && conversational) {
    return "mixed";
  }
  if (operational) {
    return "operational";
  }
  if (conversational) {
    return "conversational";
  }
  return "mixed";
}
