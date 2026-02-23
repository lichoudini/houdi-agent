export type ConflictResolutionDeps<TSelfIntent> = {
  normalizeIntentText: (text: string) => string;
  detectSelfMaintenanceIntent: (text: string) => TSelfIntent & {
    shouldHandle: boolean;
    action?: string;
  };
  shouldBypassGmailRecipientsAmbiguity: (text: string) => boolean;
};

export function shouldBypassAmbiguousPair<TSelfIntent>(
  pair: string,
  text: string,
  deps: ConflictResolutionDeps<TSelfIntent>,
): boolean {
  if (pair === "gmail|gmail-recipients" && deps.shouldBypassGmailRecipientsAmbiguity(text)) {
    return true;
  }

  if (pair === "self-maintenance|workspace") {
    const selfIntent = deps.detectSelfMaintenanceIntent(text);
    const normalized = deps.normalizeIntentText(text);
    const explicitWorkspaceCue = /\b(workspace|archivo|carpeta|ruta|path|directorio|pdf|txt|csv|json|md)\b/.test(normalized);
    if (selfIntent.shouldHandle && (selfIntent.action === "add-skill" || selfIntent.action === "list-skills") && !explicitWorkspaceCue) {
      return true;
    }
  }

  if (pair === "self-maintenance|web") {
    const selfIntent = deps.detectSelfMaintenanceIntent(text);
    const normalized = deps.normalizeIntentText(text);
    const explicitWebCue = /\b(web|internet|url|link|links|enlace|enlaces|noticias|google)\b/.test(normalized);
    if (selfIntent.shouldHandle && selfIntent.action === "list-skills" && !explicitWebCue) {
      return true;
    }
  }

  if (pair === "schedule|web" || pair === "memory|schedule") {
    const normalized = deps.normalizeIntentText(text);
    const hasScheduleCue = /\b(recordatorio|recordatorios|tarea|tareas|agenda|agendar|programad|programar|calendario|pendiente|pendientes)\b/.test(
      normalized,
    );
    const hasWebCue = /\b(web|internet|url|link|links|enlace|enlaces|google|noticias|novedades)\b/.test(normalized);
    if (hasScheduleCue && !hasWebCue) {
      return true;
    }
  }

  return false;
}
