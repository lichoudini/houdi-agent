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

type AdminSecurityOptions = {
  approvalTtlMs: number;
};

function buildApprovalId(): string {
  return `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    const approval: PendingApproval = {
      id: buildApprovalId(),
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
    const approval = this.pendingById.get(id);
    if (!approval) {
      return null;
    }
    if (typeof chatId === "number" && approval.chatId !== chatId) {
      return null;
    }
    this.pendingById.delete(id);
    return approval;
  }

  denyApproval(id: string, chatId?: number): PendingApproval | null {
    this.purgeExpired();
    const approval = this.pendingById.get(id);
    if (!approval) {
      return null;
    }
    if (typeof chatId === "number" && approval.chatId !== chatId) {
      return null;
    }
    this.pendingById.delete(id);
    return approval;
  }

  clearAllApprovals(): number {
    const count = this.pendingById.size;
    this.pendingById.clear();
    return count;
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
