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

  return false;
}
