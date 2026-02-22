function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export function shouldBypassGmailRecipientsAmbiguity(text: string): boolean {
  const original = text.trim();
  if (!original) {
    return false;
  }
  const normalized = normalizeIntentText(original);
  const hasEmailAddress = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(original);
  const hasMailNoun = /\b(correo|correos|mail|mails|email|emails|gmail|bandeja|inbox)\b/.test(normalized);
  const hasMailOperationVerb =
    /\b(envi\w*|mand\w*|escrib\w*|redact\w*|respond\w*|lee|leer|abre|abrir|mostra|mostrar|revisa|revisar|consulta|consultar|lista|listar|ver)\b/.test(
      normalized,
    );
  const hasRecipientNoun = /\b(destinatari[oa]s?|contactos?|agenda\s+de\s+(?:correo|mail|email)|agenda\s+de\s+destinatarios?)\b/.test(
    normalized,
  );
  const hasRecipientMgmtVerb =
    /\b(agrega|agregar|anade|añade|crea|crear|guarda|guardar|registra|registrar|actualiza|actualizar|edita|editar|modifica|modificar|cambia|cambiar|elimina|eliminar|borra|borrar|quita|quitar)\b/.test(
      normalized,
    );

  if (hasEmailAddress) {
    return true;
  }
  if (hasMailNoun && hasMailOperationVerb) {
    return true;
  }
  if (hasRecipientNoun && hasRecipientMgmtVerb && !hasMailOperationVerb) {
    return true;
  }
  return false;
}
