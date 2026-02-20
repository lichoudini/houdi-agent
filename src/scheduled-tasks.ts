import fs from "node:fs/promises";
import path from "node:path";

export type ScheduledTaskStatus = "pending" | "done" | "canceled";

export type ScheduledTask = {
  id: string;
  chatId: number;
  userId?: number;
  title: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  status: ScheduledTaskStatus;
  completedAt?: string;
  canceledAt?: string;
  failureCount: number;
  lastError?: string;
  retryAfter?: string;
};

type ScheduledTaskStorage = {
  tasks: ScheduledTask[];
};

export type CreateScheduledTaskInput = {
  chatId: number;
  userId?: number;
  title: string;
  dueAt: Date;
};

export type UpdateScheduledTaskInput = {
  title?: string;
  dueAt?: Date;
};

type ScheduledTaskServiceOptions = {
  filePath: string;
};

function generateTaskId(): string {
  return `tsk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function isIsoDateLike(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime());
}

function toIso(input: Date): string {
  return new Date(input.getTime()).toISOString();
}

function taskComparator(a: ScheduledTask, b: ScheduledTask): number {
  const byDue = a.dueAt.localeCompare(b.dueAt);
  if (byDue !== 0) {
    return byDue;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

function normalizeTask(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const title = typeof obj.title === "string" ? normalizeTitle(obj.title) : "";
  const dueAt = typeof obj.dueAt === "string" ? obj.dueAt.trim() : "";
  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt.trim() : "";
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt.trim() : "";
  const status = typeof obj.status === "string" ? obj.status.trim() : "";
  const chatIdRaw = obj.chatId;
  const userIdRaw = obj.userId;
  const failureCountRaw = obj.failureCount;

  const chatId =
    typeof chatIdRaw === "number" && Number.isFinite(chatIdRaw)
      ? Math.floor(chatIdRaw)
      : Number.parseInt(String(chatIdRaw ?? ""), 10);
  const userId =
    typeof userIdRaw === "number" && Number.isFinite(userIdRaw) && userIdRaw > 0
      ? Math.floor(userIdRaw)
      : undefined;
  const failureCount = clampInt(
    typeof failureCountRaw === "number" && Number.isFinite(failureCountRaw)
      ? failureCountRaw
      : Number.parseInt(String(failureCountRaw ?? 0), 10),
    0,
    10_000,
  );

  if (!id || !title || !Number.isFinite(chatId)) {
    return null;
  }
  if (!isIsoDateLike(dueAt) || !isIsoDateLike(createdAt) || !isIsoDateLike(updatedAt)) {
    return null;
  }
  if (status !== "pending" && status !== "done" && status !== "canceled") {
    return null;
  }

  const completedAt =
    typeof obj.completedAt === "string" && isIsoDateLike(obj.completedAt) ? obj.completedAt : undefined;
  const canceledAt =
    typeof obj.canceledAt === "string" && isIsoDateLike(obj.canceledAt) ? obj.canceledAt : undefined;
  const retryAfter =
    typeof obj.retryAfter === "string" && isIsoDateLike(obj.retryAfter) ? obj.retryAfter : undefined;
  const lastError = typeof obj.lastError === "string" ? obj.lastError.slice(0, 1000) : undefined;

  return {
    id,
    chatId,
    userId,
    title,
    dueAt: new Date(dueAt).toISOString(),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    status: status as ScheduledTaskStatus,
    ...(completedAt ? { completedAt: new Date(completedAt).toISOString() } : {}),
    ...(canceledAt ? { canceledAt: new Date(canceledAt).toISOString() } : {}),
    ...(retryAfter ? { retryAfter: new Date(retryAfter).toISOString() } : {}),
    ...(lastError ? { lastError } : {}),
    failureCount,
  };
}

export class ScheduledTaskService {
  private readonly filePath: string;
  private tasks: ScheduledTask[] = [];
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: ScheduledTaskServiceOptions) {
    this.filePath = path.resolve(options.filePath);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      const empty: ScheduledTaskStorage = { tasks: [] };
      await fs.writeFile(this.filePath, `${JSON.stringify(empty, null, 2)}\n`, "utf8");
      this.tasks = [];
      this.loaded = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { tasks: [] };
    }

    const listRaw = Array.isArray((parsed as { tasks?: unknown })?.tasks)
      ? ((parsed as { tasks: unknown[] }).tasks ?? [])
      : [];
    this.tasks = listRaw.map((item) => normalizeTask(item)).filter((item): item is ScheduledTask => Boolean(item));
    this.tasks.sort(taskComparator);
    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("ScheduledTaskService no está cargado. Llama load() primero.");
    }
  }

  private queuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      const storage: ScheduledTaskStorage = { tasks: this.tasks };
      await fs.writeFile(this.filePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");
    });
    return this.persistQueue;
  }

  listPending(chatId: number): ScheduledTask[] {
    this.ensureLoaded();
    return this.tasks
      .filter((task) => task.chatId === chatId && task.status === "pending")
      .sort(taskComparator)
      .map((task) => ({ ...task }));
  }

  listAll(chatId: number): ScheduledTask[] {
    this.ensureLoaded();
    return this.tasks
      .filter((task) => task.chatId === chatId)
      .sort(taskComparator)
      .map((task) => ({ ...task }));
  }

  resolveTaskByRef(chatId: number, refInput: string): ScheduledTask | null {
    this.ensureLoaded();
    const ref = refInput.trim().toLowerCase();
    if (!ref) {
      return null;
    }

    const pending = this.listPending(chatId);
    if (pending.length === 0) {
      return null;
    }

    if (ref === "last" || ref === "ultimo" || ref === "último" || ref === "ultima" || ref === "última") {
      return { ...pending[pending.length - 1]! };
    }

    if (/^\d+$/.test(ref)) {
      const index = Number.parseInt(ref, 10);
      if (index < 1 || index > pending.length) {
        return null;
      }
      return { ...pending[index - 1]! };
    }

    const byId = pending.find((task) => task.id.toLowerCase() === ref);
    return byId ? { ...byId } : null;
  }

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    this.ensureLoaded();
    const title = normalizeTitle(input.title);
    if (!title) {
      throw new Error("Descripción vacía");
    }
    const dueAt = new Date(input.dueAt.getTime());
    if (!Number.isFinite(dueAt.getTime())) {
      throw new Error("Fecha/hora inválida");
    }

    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: generateTaskId(),
      chatId: Math.floor(input.chatId),
      ...(typeof input.userId === "number" && Number.isFinite(input.userId) && input.userId > 0
        ? { userId: Math.floor(input.userId) }
        : {}),
      title,
      dueAt: dueAt.toISOString(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      failureCount: 0,
    };

    this.tasks.push(task);
    this.tasks.sort(taskComparator);
    await this.queuePersist();
    return { ...task };
  }

  async updateTask(taskId: string, changes: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    this.ensureLoaded();
    const id = taskId.trim();
    const index = this.tasks.findIndex((task) => task.id === id && task.status === "pending");
    if (index < 0) {
      throw new Error("Tarea no encontrada o no editable");
    }

    const current = this.tasks[index]!;
    const next: ScheduledTask = { ...current };
    if (typeof changes.title === "string") {
      const title = normalizeTitle(changes.title);
      if (!title) {
        throw new Error("Descripción vacía");
      }
      next.title = title;
    }
    if (changes.dueAt) {
      const date = new Date(changes.dueAt.getTime());
      if (!Number.isFinite(date.getTime())) {
        throw new Error("Fecha/hora inválida");
      }
      next.dueAt = date.toISOString();
      next.retryAfter = undefined;
      next.lastError = undefined;
    }
    next.updatedAt = new Date().toISOString();
    this.tasks[index] = next;
    this.tasks.sort(taskComparator);
    await this.queuePersist();
    return { ...next };
  }

  async cancelTask(taskId: string): Promise<ScheduledTask> {
    this.ensureLoaded();
    const id = taskId.trim();
    const index = this.tasks.findIndex((task) => task.id === id && task.status === "pending");
    if (index < 0) {
      throw new Error("Tarea no encontrada o ya finalizada");
    }

    const next: ScheduledTask = {
      ...this.tasks[index]!,
      status: "canceled",
      canceledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks[index] = next;
    this.tasks.sort(taskComparator);
    await this.queuePersist();
    return { ...next };
  }

  dueTasks(nowInput?: Date): ScheduledTask[] {
    this.ensureLoaded();
    const now = nowInput ? nowInput.getTime() : Date.now();
    return this.tasks
      .filter((task) => {
        if (task.status !== "pending") {
          return false;
        }
        const dueAt = new Date(task.dueAt).getTime();
        if (!Number.isFinite(dueAt) || dueAt > now) {
          return false;
        }
        if (task.retryAfter) {
          const retryAt = new Date(task.retryAfter).getTime();
          if (Number.isFinite(retryAt) && retryAt > now) {
            return false;
          }
        }
        return true;
      })
      .sort(taskComparator)
      .map((task) => ({ ...task }));
  }

  async markDelivered(taskId: string, deliveredAtInput?: Date): Promise<ScheduledTask> {
    this.ensureLoaded();
    const id = taskId.trim();
    const index = this.tasks.findIndex((task) => task.id === id && task.status === "pending");
    if (index < 0) {
      throw new Error("Tarea no encontrada o no pendiente");
    }

    const deliveredAt = deliveredAtInput ?? new Date();
    const next: ScheduledTask = {
      ...this.tasks[index]!,
      status: "done",
      completedAt: deliveredAt.toISOString(),
      updatedAt: deliveredAt.toISOString(),
      retryAfter: undefined,
      lastError: undefined,
    };
    this.tasks[index] = next;
    this.tasks.sort(taskComparator);
    await this.queuePersist();
    return { ...next };
  }

  async markDeliveryFailure(taskId: string, errorMessage: string, nowInput?: Date): Promise<ScheduledTask> {
    this.ensureLoaded();
    const id = taskId.trim();
    const index = this.tasks.findIndex((task) => task.id === id && task.status === "pending");
    if (index < 0) {
      throw new Error("Tarea no encontrada o no pendiente");
    }

    const now = nowInput ?? new Date();
    const previous = this.tasks[index]!;
    const nextFailureCount = clampInt(previous.failureCount + 1, 1, 10_000);
    const retryMinutes = Math.min(30, Math.max(1, 2 ** Math.min(5, nextFailureCount)));
    const retryAfter = new Date(now.getTime() + retryMinutes * 60 * 1000).toISOString();

    const next: ScheduledTask = {
      ...previous,
      failureCount: nextFailureCount,
      lastError: errorMessage.slice(0, 1000),
      retryAfter,
      updatedAt: now.toISOString(),
    };
    this.tasks[index] = next;
    this.tasks.sort(taskComparator);
    await this.queuePersist();
    return { ...next };
  }
}

