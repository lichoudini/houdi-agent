export type ApprovalKind = "exec" | "ai-shell" | "reboot";

export type PendingApproval = {
  id: string;
  kind: ApprovalKind;
  chatId: number;
  userId: number;
  agentName: string;
  commandLine: string;
  createdAt: number;
  expiresAt: number;
  note?: string;
};

export type AdminModeSnapshot = {
  chatId: number;
  enabled: boolean;
};

type AdminSecurityOptions = {
  approvalTtlMs: number;
};

const APPROVAL_ID_LENGTH = 4;
const APPROVAL_ID_ALPHABET = "0123456789";

function randomApprovalId(): string {
  let out = "";
  for (let i = 0; i < APPROVAL_ID_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * APPROVAL_ID_ALPHABET.length);
    out += APPROVAL_ID_ALPHABET[idx] ?? "x";
  }
  return out;
}

function normalizeApprovalId(id: string): string {
  return id.trim().toLowerCase();
}

export class AdminSecurityController {
  private readonly adminModeByChat = new Map<number, boolean>();
  private readonly pendingById = new Map<string, PendingApproval>();
  private panicMode = false;

  constructor(private readonly options: AdminSecurityOptions) {}

  isAdminModeEnabled(chatId: number): boolean {
    return this.adminModeByChat.get(chatId) ?? false;
  }

  setAdminMode(chatId: number, enabled: boolean): void {
    this.adminModeByChat.set(chatId, enabled);
  }

  isPanicModeEnabled(): boolean {
    return this.panicMode;
  }

  setPanicMode(enabled: boolean): void {
    this.panicMode = enabled;
  }

  createApproval(params: {
    kind: ApprovalKind;
    chatId: number;
    userId: number;
    agentName: string;
    commandLine: string;
    note?: string;
  }): PendingApproval {
    this.purgeExpired();
    const now = Date.now();
    let id = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      id = randomApprovalId();
      if (!this.pendingById.has(id)) {
        break;
      }
    }
    if (!id || this.pendingById.has(id)) {
      throw new Error("No se pudo generar un ID de aprobación único.");
    }
    const approval: PendingApproval = {
      id,
      kind: params.kind,
      chatId: params.chatId,
      userId: params.userId,
      agentName: params.agentName,
      commandLine: params.commandLine,
      createdAt: now,
      expiresAt: now + this.options.approvalTtlMs,
      ...(params.note ? { note: params.note } : {}),
    };
    this.pendingById.set(approval.id, approval);
    return approval;
  }

  listApprovals(chatId?: number): PendingApproval[] {
    this.purgeExpired();
    return [...this.pendingById.values()]
      .filter((item) => (typeof chatId === "number" ? item.chatId === chatId : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  consumeApproval(id: string, chatId?: number): PendingApproval | null {
    this.purgeExpired();
    const normalizedId = normalizeApprovalId(id);
    const approval = this.pendingById.get(normalizedId);
    if (!approval) {
      return null;
    }
    if (typeof chatId === "number" && approval.chatId !== chatId) {
      return null;
    }
    this.pendingById.delete(normalizedId);
    return approval;
  }

  denyApproval(id: string, chatId?: number): PendingApproval | null {
    this.purgeExpired();
    const normalizedId = normalizeApprovalId(id);
    const approval = this.pendingById.get(normalizedId);
    if (!approval) {
      return null;
    }
    if (typeof chatId === "number" && approval.chatId !== chatId) {
      return null;
    }
    this.pendingById.delete(normalizedId);
    return approval;
  }

  clearAllApprovals(): number {
    const count = this.pendingById.size;
    this.pendingById.clear();
    return count;
  }

  replaceApprovals(approvals: PendingApproval[]): void {
    this.pendingById.clear();
    const now = Date.now();
    for (const approval of approvals) {
      const id = normalizeApprovalId(approval.id);
      if (!id) {
        continue;
      }
      if (!Number.isFinite(approval.chatId) || !Number.isFinite(approval.userId)) {
        continue;
      }
      if (!Number.isFinite(approval.createdAt) || !Number.isFinite(approval.expiresAt)) {
        continue;
      }
      if (approval.expiresAt <= now) {
        continue;
      }
      this.pendingById.set(id, {
        ...approval,
        id,
      });
    }
    this.purgeExpired();
  }

  snapshotApprovals(chatId?: number): PendingApproval[] {
    return this.listApprovals(chatId);
  }

  snapshotAdminModes(): AdminModeSnapshot[] {
    return [...this.adminModeByChat.entries()]
      .map(([chatId, enabled]) => ({ chatId, enabled }))
      .filter((entry) => Number.isFinite(entry.chatId))
      .sort((a, b) => a.chatId - b.chatId);
  }

  replaceAdminModes(modes: AdminModeSnapshot[]): void {
    this.adminModeByChat.clear();
    for (const mode of modes) {
      if (!Number.isFinite(mode.chatId)) {
        continue;
      }
      this.adminModeByChat.set(Math.floor(mode.chatId), Boolean(mode.enabled));
    }
  }

  getApprovalTtlMs(): number {
    return this.options.approvalTtlMs;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, approval] of this.pendingById.entries()) {
      if (approval.expiresAt <= now) {
        this.pendingById.delete(id);
      }
    }
  }
}
