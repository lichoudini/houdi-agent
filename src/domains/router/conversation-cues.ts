export function isLikelyConversationalNarrative(params: {
  normalizedText: string;
  hasOperationalCue: boolean;
}): boolean {
  const normalized = params.normalizedText.trim();
  if (!normalized || params.hasOperationalCue) {
    return false;
  }

  const hasDirectiveCue =
    /\b(quiero|necesito|por favor|haz|hace|crea|crear|arma|guardar|guarda|envia|manda|revisa|busca|lista|muestra|programa|recorda|recordame|recordarme|recuerda|recuerdame)\b/.test(
      normalized,
    );
  if (hasDirectiveCue) {
    return false;
  }

  const hasFirstPersonCue = /\b(yo|me|mi|mis|conmigo|nos|nosotros|nosotras)\b/.test(normalized);
  const hasNarrativeVerb =
    /\b(tuve|fui|estuve|comi|almorce|merende|cene|sali|volvi|dormi|descanse|camine|viaje|trabaje|charle|hable|disfrute|me senti|me dormi)\b/.test(
      normalized,
    ) || /\bla pase\b/.test(normalized);
  const hasNarrativeTimeCue = /\b(hoy|ayer|anoche|esta manana|esta tarde|esta noche|reci[e]n)\b/.test(normalized);
  const hasNarrativeMoodCue = /\b(gran dia|buen dia|la pase bien|la pase mal)\b/.test(normalized);

  return (hasFirstPersonCue && hasNarrativeVerb) || (hasNarrativeTimeCue && (hasNarrativeVerb || hasNarrativeMoodCue));
}
