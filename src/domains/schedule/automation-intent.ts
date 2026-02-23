export type ScheduledAutomationDomain = "gmail" | "web" | "workspace" | "lim" | "command";

export type ScheduledAutomationIntent = {
  instruction?: string;
  recurrenceDaily: boolean;
  domain?: ScheduledAutomationDomain;
};

type DetectScheduledAutomationIntentParams = {
  text: string;
  normalizeIntentText: (text: string) => string;
  stripScheduleTemporalPhrases: (text: string) => string;
  sanitizeTitle: (text: string) => string;
};

const DAILY_RECURRENCE_REGEX = /\b(?:todos?\s+los?\s+dias?|cada\s+dia|diari(?:o|a|amente))\b/i;

export function detectScheduledAutomationIntent(params: DetectScheduledAutomationIntentParams): ScheduledAutomationIntent {
  const original = params.text.trim();
  if (!original) {
    return { recurrenceDaily: false };
  }

  const normalized = params.normalizeIntentText(original);
  const recurrenceDaily = DAILY_RECURRENCE_REGEX.test(normalized);

  const directInstruction =
    original.match(/\b(?:ejecuta(?:r)?|corre(?:r)?|run|lanz(?:a|ar)|dispar(?:a|ar)|haz|hace(?:r)?)\s+(.+)$/i)?.[1] ??
    original.match(/\b(?:que\s+)?(?:busque|buscar|consulte|consultar|revise|revisar|lea|leer|liste|listar|envie|enviar)\s+(.+)$/i)?.[1] ??
    "";

  const baseCandidate = directInstruction || stripAutomationLead(original, params);
  const instruction = params.sanitizeTitle(stripTrailingAutomationNoise(baseCandidate));
  if (!instruction) {
    return { recurrenceDaily };
  }

  const domain = detectAutomationDomain(instruction, params.normalizeIntentText);
  if (!domain) {
    return { recurrenceDaily };
  }

  return {
    instruction,
    recurrenceDaily,
    domain,
  };
}

function stripAutomationLead(raw: string, params: DetectScheduledAutomationIntentParams): string {
  const strippedTemporal = params.stripScheduleTemporalPhrases(params.normalizeIntentText(raw))
    .replace(DAILY_RECURRENCE_REGEX, " ")
    .replace(
      /\b(record(?:a|á)(?:me|rme|r)?|recuerd(?:a|á)(?:me|r)?|agend(?:a|á)(?:me|r)?|program(?:a|á)(?:r)?|cre(?:a|á)(?:r)?|gener(?:a|á)(?:r)?|tareas?|recordatorios?)\b/gi,
      " ",
    )
    .replace(/\b(envi(?:a|á)(?:me|rme|r)?|manda(?:me|rme|r)?)\b/gi, " ")
    .replace(/\b(?:a\s+las?\s+)?\d{1,2}(?::\d{2})\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b(?:una?|un|para)\b/gi, " ")
    .replace(/\b(?:a\s+las?|por\s+la|de\s+la|en\s+la)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return strippedTemporal;
}

function stripTrailingAutomationNoise(raw: string): string {
  return raw
    .replace(/^["'`:,;.\s-]+|["'`:,;.\s-]+$/g, "")
    .replace(/\s+(?:por\s+favor|porfa)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectAutomationDomain(
  instruction: string,
  normalizeIntentText: (text: string) => string,
): ScheduledAutomationDomain | undefined {
  const normalized = normalizeIntentText(instruction);

  if (/\b(lim|lista\s+lim|consulta\s+lim|buscar\s+lim|revisar\s+lim)\b/.test(normalized)) {
    return "lim";
  }
  if (/\b(workspace|archivo|archivos|carpeta|carpetas|directorio|directorios|\/workspace|\/images|\/img|\/files)\b/.test(normalized)) {
    return "workspace";
  }
  if (/\b(correo|mail|email|gmail|enviar\s+correo|enviar\s+mail|enviar\s+email|\/gmail)\b/.test(normalized)) {
    return "gmail";
  }
  if (/\b(web|internet|noticias?|news|buscar\s+en\s+web|\/web|\/webask|\/webopen)\b/.test(normalized)) {
    return "web";
  }
  if (
    /\b(ejecuta(?:r)?|run|comando|shell|script|lista\s+lim)\b/.test(normalized) ||
    /(?:^|\s)\/(?:status|health|task)\b/.test(normalized)
  ) {
    return "command";
  }
  return undefined;
}
