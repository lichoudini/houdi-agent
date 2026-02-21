import fs from "node:fs/promises";
import path from "node:path";
import type { IntentRouteName } from "../../intent-semantic-router.js";
import type { SemanticRouteConfig } from "../../intent-semantic-router.js";

type PersistedChatRoutes = {
  version: number;
  updatedAt: string;
  chats: Array<{
    chatId: number;
    updatedAt: string;
    routes: SemanticRouteConfig[];
  }>;
};

function mergeRoutes(base: SemanticRouteConfig[], override: SemanticRouteConfig[]): SemanticRouteConfig[] {
  const byName = new Map(base.map((route) => [route.name, route]));
  for (const route of override) {
    byName.set(route.name, route);
  }
  return Array.from(byName.values()).map((route) => ({
    name: route.name,
    threshold: route.threshold,
    utterances: [...route.utterances],
  }));
}

export class DynamicIntentRoutesStore {
  private readonly byChat = new Map<number, { updatedAt: string; routes: SemanticRouteConfig[] }>();

  getRoutesForChat(chatId: number): SemanticRouteConfig[] | null {
    const state = this.byChat.get(chatId);
    if (!state) {
      return null;
    }
    return state.routes.map((route) => ({
      name: route.name,
      threshold: route.threshold,
      utterances: [...route.utterances],
    }));
  }

  listChatIds(): number[] {
    return Array.from(this.byChat.keys()).sort((a, b) => a - b);
  }

  buildEffectiveRoutes(chatId: number, baseRoutes: SemanticRouteConfig[]): SemanticRouteConfig[] {
    const override = this.getRoutesForChat(chatId);
    if (!override) {
      return baseRoutes.map((route) => ({
        name: route.name,
        threshold: route.threshold,
        utterances: [...route.utterances],
      }));
    }
    return mergeRoutes(baseRoutes, override);
  }

  appendUtterances(chatId: number, routeName: IntentRouteName, utterances: string[], baseRoutes: SemanticRouteConfig[]): number {
    const normalized = utterances
      .map((item) => item.trim())
      .filter((item) => item.length >= 6 && item.length <= 220);
    if (normalized.length === 0) {
      return 0;
    }
    const current = this.buildEffectiveRoutes(chatId, baseRoutes);
    const route = current.find((item) => item.name === routeName);
    if (!route) {
      return 0;
    }
    const set = new Set(route.utterances.map((item) => item.trim().toLowerCase()));
    let added = 0;
    for (const utterance of normalized) {
      const key = utterance.toLowerCase();
      if (set.has(key)) {
        continue;
      }
      route.utterances.push(utterance);
      set.add(key);
      added += 1;
    }
    if (added === 0) {
      return 0;
    }
    this.byChat.set(chatId, {
      updatedAt: new Date().toISOString(),
      routes: current,
    });
    return added;
  }

  async loadFromFile(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const raw = await fs.readFile(resolved, "utf8");
    const parsed = JSON.parse(raw) as PersistedChatRoutes;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.chats)) {
      throw new Error("archivo de chat-routes inválido");
    }
    this.byChat.clear();
    for (const chat of parsed.chats) {
      if (!chat || typeof chat.chatId !== "number" || !Array.isArray(chat.routes)) {
        continue;
      }
      const routes = chat.routes
        .filter((route) => route && typeof route.name === "string" && Array.isArray(route.utterances))
        .map((route) => ({
          name: route.name as IntentRouteName,
          threshold: Math.max(0.01, Math.min(0.99, Number(route.threshold) || 0.25)),
          utterances: route.utterances.map((item) => String(item).trim()).filter(Boolean),
        }))
        .filter((route) => route.utterances.length > 0);
      if (routes.length === 0) {
        continue;
      }
      this.byChat.set(chat.chatId, {
        updatedAt: chat.updatedAt || new Date().toISOString(),
        routes,
      });
    }
  }

  async saveToFile(filePath: string): Promise<void> {
    const resolved = path.resolve(process.cwd(), filePath);
    const payload: PersistedChatRoutes = {
      version: 1,
      updatedAt: new Date().toISOString(),
      chats: Array.from(this.byChat.entries()).map(([chatId, state]) => ({
        chatId,
        updatedAt: state.updatedAt,
        routes: state.routes.map((route) => ({
          name: route.name,
          threshold: route.threshold,
          utterances: [...route.utterances],
        })),
      })),
    };
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
