import { extractSelfSkillInstructionFromText, isSkillDraftMultiMessageRequested } from "./natural.js";

export type SelfMaintenanceIntent = {
  shouldHandle: boolean;
  action?: "add-skill" | "delete-skill" | "list-skills" | "restart-service" | "update-service";
  instruction?: string;
  skillIndex?: number;
  skillRef?: string;
};

export function normalizeSelfSkillIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export function detectSelfMaintenanceIntent(text: string): SelfMaintenanceIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeSelfSkillIntentText(original);
  const isQuestion = original.includes("?");

  const listSkillsRequested =
    /\b(que|cuales)\b.*\b(habilidades|skills|reglas)\b/.test(normalized) &&
    /\b(tenes|tienes|agregadas|dinamicas|dynamicas|actuales)\b/.test(normalized);
  if (listSkillsRequested) {
    return { shouldHandle: true, action: "list-skills" };
  }

  const deleteSkillIntent =
    /\b(elimina|eliminar|borra|borrar|quita|quitar|remueve|remover)\b/.test(normalized) &&
    /\b(habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\b/.test(normalized);
  if (!isQuestion && deleteSkillIntent) {
    const wantsLast = /\b(ultimo|ultima|final)\b/.test(normalized);
    const refMatch =
      original.match(/#([a-z0-9][a-z0-9_-]{2,40})\b/i) ??
      original.match(/\b(?:id|ref)\s*[:=]?\s*([a-z0-9][a-z0-9_-]{2,40})\b/i);
    const skillRef = refMatch?.[1]?.trim();
    const indexRaw =
      normalized.match(/\b(?:habilidad|skill|regla|capacidad)\s*(?:numero|nro|#)?\s*(\d{1,3})\b/)?.[1] ??
      normalized.match(/\b(?:numero|nro|#)\s*(\d{1,3})\b/)?.[1] ??
      normalized.match(/\b(\d{1,3})\b/)?.[1];
    const parsedIndex = indexRaw ? Number.parseInt(indexRaw, 10) : Number.NaN;
    if (wantsLast) {
      return { shouldHandle: true, action: "delete-skill", skillIndex: -1 };
    }
    if (skillRef) {
      return { shouldHandle: true, action: "delete-skill", skillRef };
    }
    if (Number.isFinite(parsedIndex) && parsedIndex > 0) {
      return { shouldHandle: true, action: "delete-skill", skillIndex: parsedIndex };
    }
    return { shouldHandle: true, action: "delete-skill" };
  }

  const restartRequested =
    /\b(reinicia|reiniciate|reiniciar|restart)\b.*\b(agente|bot|servicio)\b/.test(normalized) ||
    /\b(reinicia|reiniciate|reiniciar|restart)\b.*\b(houdi)\b/.test(normalized);
  if (!isQuestion && restartRequested) {
    return { shouldHandle: true, action: "restart-service" };
  }

  const updateVerb =
    /\b(actualiza|actualizar|actualizate|updatea|updatear|upgradea|upgrade|sincroniza|sincronizar|ponete al dia|ponte al dia)\b/.test(
      normalized,
    );
  const updateNoun = /\b(agente|bot|houdi|repo|repositorio|version|versiones|codigo|release)\b/.test(normalized);
  if (!isQuestion && updateVerb && updateNoun) {
    return { shouldHandle: true, action: "update-service" };
  }

  if (!isQuestion && isSkillDraftMultiMessageRequested(normalized)) {
    const instruction = extractSelfSkillInstructionFromText(original);
    return instruction
      ? { shouldHandle: true, action: "add-skill", instruction }
      : { shouldHandle: true, action: "add-skill" };
  }

  const addSkillVerb =
    /\b(agrega|agregar|suma|sumar|anade|añade|incorpora|incorporar|crea|crear|genera|generar|define|definir|configura|configurar|habilita|habilitar|entrena|entrenar|ensena|enseña|mejorate|mejora|arma|armar|construi|construir)\b/.test(
      normalized,
    );
  const addSkillNoun = /\b(habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\b/.test(normalized);
  const addSkillIntent = addSkillVerb && addSkillNoun;
  const conciseSkillDefinition = /\b(?:nueva\s+)?(?:habilidad(?:es)?|skill(?:s)?|regla(?:s)?|capacidad(?:es)?)\s*[:=-]\s*.+/.test(
    normalized,
  );
  if (addSkillIntent || conciseSkillDefinition) {
    const instruction = extractSelfSkillInstructionFromText(original);
    if (instruction) {
      return { shouldHandle: true, action: "add-skill", instruction };
    }
    return { shouldHandle: true, action: "add-skill" };
  }

  return { shouldHandle: false };
}
