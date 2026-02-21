import fs from "node:fs/promises";
import path from "node:path";
import type { SemanticRouteConfig } from "../../intent-semantic-router.js";

export type RouterVersionSnapshot = {
  id: string;
  createdAt: string;
  label: string;
  routes: SemanticRouteConfig[];
  hybridAlpha: number;
  minScoreGap: number;
};

type RouterVersionStoreFile = {
  version: number;
  updatedAt: string;
  activeVersionId?: string;
  canary?: {
    enabled: boolean;
    splitPercent: number;
    versionId?: string;
  };
  snapshots: RouterVersionSnapshot[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class RouterVersionStore {
  private snapshots: RouterVersionSnapshot[] = [];
  private activeVersionId: string | null = null;
  private canary: { enabled: boolean; splitPercent: number; versionId: string | null } = {
    enabled: false,
    splitPercent: 0,
    versionId: null,
  };

  async load(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const raw = await fs.readFile(resolved, "utf8");
    const parsed = JSON.parse(raw) as RouterVersionStoreFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.snapshots)) {
      throw new Error("archivo de versiones inválido");
    }
    this.snapshots = parsed.snapshots
      .filter((item) => item && typeof item.id === "string" && Array.isArray(item.routes))
      .map((item) => ({
        id: item.id,
        createdAt: item.createdAt || new Date().toISOString(),
        label: item.label || "snapshot",
        routes: item.routes,
        hybridAlpha: clamp(item.hybridAlpha, 0.05, 0.95),
        minScoreGap: clamp(item.minScoreGap, 0, 0.5),
      }));
    this.activeVersionId = parsed.activeVersionId ?? null;
    this.canary = {
      enabled: Boolean(parsed.canary?.enabled),
      splitPercent: clamp(Math.floor(parsed.canary?.splitPercent ?? 0), 0, 100),
      versionId: parsed.canary?.versionId ?? null,
    };
  }

  async save(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const payload: RouterVersionStoreFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeVersionId: this.activeVersionId ?? undefined,
      canary: {
        enabled: this.canary.enabled,
        splitPercent: this.canary.splitPercent,
        versionId: this.canary.versionId ?? undefined,
      },
      snapshots: this.snapshots.slice(-50),
    };
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  createSnapshot(params: {
    label: string;
    routes: SemanticRouteConfig[];
    hybridAlpha: number;
    minScoreGap: number;
  }): RouterVersionSnapshot {
    const snapshot: RouterVersionSnapshot = {
      id: `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      label: params.label.trim() || "snapshot",
      routes: params.routes.map((route) => ({
        name: route.name,
        threshold: route.threshold,
        utterances: [...route.utterances],
        negativeUtterances: [...(route.negativeUtterances ?? [])],
      })),
      hybridAlpha: clamp(params.hybridAlpha, 0.05, 0.95),
      minScoreGap: clamp(params.minScoreGap, 0, 0.5),
    };
    this.snapshots.push(snapshot);
    this.activeVersionId = snapshot.id;
    return snapshot;
  }

  listSnapshots(): RouterVersionSnapshot[] {
    return [...this.snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getSnapshot(versionId: string): RouterVersionSnapshot | null {
    return this.snapshots.find((item) => item.id === versionId) ?? null;
  }

  getActiveSnapshot(): RouterVersionSnapshot | null {
    if (!this.activeVersionId) {
      return null;
    }
    return this.getSnapshot(this.activeVersionId);
  }

  rollbackTo(versionId: string): RouterVersionSnapshot | null {
    const snapshot = this.getSnapshot(versionId);
    if (!snapshot) {
      return null;
    }
    this.activeVersionId = snapshot.id;
    return snapshot;
  }

  setCanary(versionId: string, splitPercent: number): boolean {
    const snapshot = this.getSnapshot(versionId);
    if (!snapshot) {
      return false;
    }
    this.canary = {
      enabled: true,
      splitPercent: clamp(Math.floor(splitPercent), 0, 100),
      versionId: snapshot.id,
    };
    return true;
  }

  disableCanary(): void {
    this.canary = {
      enabled: false,
      splitPercent: 0,
      versionId: null,
    };
  }

  getCanaryStatus(): { enabled: boolean; splitPercent: number; versionId: string | null } {
    return { ...this.canary };
  }

  resolveRoutesForChat(chatId: number, fallbackRoutes: SemanticRouteConfig[]): SemanticRouteConfig[] {
    if (!this.canary.enabled || !this.canary.versionId || this.canary.splitPercent <= 0) {
      return fallbackRoutes;
    }
    const snapshot = this.getSnapshot(this.canary.versionId);
    if (!snapshot) {
      return fallbackRoutes;
    }
    const bucket = Math.abs(chatId) % 100;
    if (bucket >= this.canary.splitPercent) {
      return fallbackRoutes;
    }
    return snapshot.routes.map((route) => ({
      name: route.name,
      threshold: route.threshold,
      utterances: [...route.utterances],
      negativeUtterances: [...(route.negativeUtterances ?? [])],
    }));
  }
}
