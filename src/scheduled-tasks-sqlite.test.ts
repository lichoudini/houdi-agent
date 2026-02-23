import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduledTaskSqliteService } from "./scheduled-tasks-sqlite.js";

test("scheduled tasks sqlite create, due and delivery", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-schedule-test-"));
  const dbPath = path.join(tempDir, "state.sqlite");

  const service = new ScheduledTaskSqliteService({ dbPath });
  await service.load();

  const created = await service.createTask({
    chatId: 77,
    title: "Recordarme enviar reporte",
    dueAt: new Date(Date.now() - 60_000),
  });

  const due = service.dueTasks(new Date());
  assert.ok(due.some((task) => task.id === created.id));

  const delivered = await service.markDelivered(created.id);
  assert.equal(delivered.status, "done");

  const pending = service.listPending(77);
  assert.equal(pending.length, 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("scheduled tasks sqlite migrate from json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-schedule-migrate-test-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const jsonPath = path.join(tempDir, "schedule.json");

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        tasks: [
          {
            id: "tsk-demo",
            chatId: 10,
            title: "demo",
            dueAt: "2026-01-01T10:00:00.000Z",
            createdAt: "2026-01-01T09:00:00.000Z",
            updatedAt: "2026-01-01T09:00:00.000Z",
            status: "pending",
            failureCount: 0,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const service = new ScheduledTaskSqliteService({ dbPath });
  await service.load();
  const migrated = await service.migrateFromJson(jsonPath);
  assert.equal(migrated, 1);

  const all = service.listAll(10);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.id, "tsk-demo");

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("scheduled tasks sqlite resolves refs with tsk underscore and ellipsis prefix", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-schedule-ref-test-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const jsonPath = path.join(tempDir, "schedule.json");

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        tasks: [
          {
            id: "tsk-mlz123-alpha",
            chatId: 10,
            title: "alpha",
            dueAt: "2026-03-01T10:00:00.000Z",
            createdAt: "2026-03-01T09:00:00.000Z",
            updatedAt: "2026-03-01T09:00:00.000Z",
            status: "pending",
            failureCount: 0,
          },
          {
            id: "tsk-mlz999-beta",
            chatId: 10,
            title: "beta",
            dueAt: "2026-03-01T11:00:00.000Z",
            createdAt: "2026-03-01T09:00:00.000Z",
            updatedAt: "2026-03-01T09:00:00.000Z",
            status: "pending",
            failureCount: 0,
          },
          {
            id: "tsk-mlx777-gamma",
            chatId: 10,
            title: "gamma",
            dueAt: "2026-03-01T12:00:00.000Z",
            createdAt: "2026-03-01T09:00:00.000Z",
            updatedAt: "2026-03-01T09:00:00.000Z",
            status: "pending",
            failureCount: 0,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const service = new ScheduledTaskSqliteService({ dbPath });
  await service.load();
  const migrated = await service.migrateFromJson(jsonPath);
  assert.equal(migrated, 3);

  const exactWithUnderscore = service.resolveTaskByRef(10, "tsk_mlz123_alpha");
  assert.equal(exactWithUnderscore?.id, "tsk-mlz123-alpha");

  const uniquePrefix = service.resolveTaskByRef(10, "tsk_mlz123...");
  assert.equal(uniquePrefix?.id, "tsk-mlz123-alpha");

  const ambiguousPrefix = service.resolveTaskByRef(10, "tsk_mlz...");
  assert.equal(ambiguousPrefix, null);

  const otherUniquePrefix = service.resolveTaskByRef(10, "tsk_mlx...");
  assert.equal(otherUniquePrefix?.id, "tsk-mlx777-gamma");

  await fs.rm(tempDir, { recursive: true, force: true });
});
