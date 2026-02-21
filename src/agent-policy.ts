import fs from "node:fs/promises";
import path from "node:path";

export type AgentCapability =
  | "exec"
  | "ai-shell"
  | "gmail.send"
  | "workspace.delete"
  | "reboot"
  | "selfupdate";

export type AgentPolicy = {
  version: number;
  previewRequired: AgentCapability[];
  approvalRequired: AgentCapability[];
  blockInSafeMode: AgentCapability[];
};

const DEFAULT_POLICY: AgentPolicy = {
  version: 1,
  previewRequired: ["exec", "gmail.send", "workspace.delete", "reboot"],
  approvalRequired: ["exec", "gmail.send", "workspace.delete", "reboot"],
  blockInSafeMode: ["ai-shell", "selfupdate", "reboot"],
};

function uniqCapabilities(values: unknown): AgentCapability[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const allowed = new Set<AgentCapability>(["exec", "ai-shell", "gmail.send", "workspace.delete", "reboot", "selfupdate"]);
  return Array.from(
    new Set(
      values
        .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
        .filter((item): item is AgentCapability => allowed.has(item as AgentCapability)),
    ),
  );
}

function parsePolicy(raw: unknown): AgentPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = Number(obj.version ?? 1);
  const version = Number.isFinite(versionRaw) && versionRaw >= 1 ? Math.floor(versionRaw) : 1;
  const parsed: AgentPolicy = {
    version,
    previewRequired: uniqCapabilities(obj.previewRequired),
    approvalRequired: uniqCapabilities(obj.approvalRequired),
    blockInSafeMode: uniqCapabilities(obj.blockInSafeMode),
  };
  return {
    version: parsed.version,
    previewRequired: parsed.previewRequired.length > 0 ? parsed.previewRequired : DEFAULT_POLICY.previewRequired,
    approvalRequired: parsed.approvalRequired.length > 0 ? parsed.approvalRequired : DEFAULT_POLICY.approvalRequired,
    blockInSafeMode: parsed.blockInSafeMode.length > 0 ? parsed.blockInSafeMode : DEFAULT_POLICY.blockInSafeMode,
  };
}

export class AgentPolicyEngine {
  private policy: AgentPolicy = DEFAULT_POLICY;

  constructor(private readonly filePath: string) {}

  getPath(): string {
    return path.resolve(this.filePath);
  }

  getPolicy(): AgentPolicy {
    return this.policy;
  }

  async load(): Promise<void> {
    const fullPath = this.getPath();
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      this.policy = parsePolicy(JSON.parse(raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/enoent/i.test(message)) {
        throw error;
      }
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      this.policy = DEFAULT_POLICY;
      await fs.writeFile(fullPath, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, "utf8");
    }
  }

  async save(policy: AgentPolicy): Promise<void> {
    this.policy = parsePolicy(policy);
    const fullPath = this.getPath();
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${JSON.stringify(this.policy, null, 2)}\n`, "utf8");
  }

  isPreviewRequired(capability: AgentCapability): boolean {
    return this.policy.previewRequired.includes(capability);
  }

  isApprovalRequired(capability: AgentCapability): boolean {
    return this.policy.approvalRequired.includes(capability);
  }

  isBlockedInSafeMode(capability: AgentCapability): boolean {
    return this.policy.blockInSafeMode.includes(capability);
  }
}
