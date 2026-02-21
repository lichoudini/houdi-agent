import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteStateStore } from "./sqlite-state-store.js";

test("sqlite state store outbox due/retry/dead-letter flow", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-sqlite-state-outbox-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const state = new SqliteStateStore(dbPath);
  await state.init();

  const now = Date.now();
  const dueId = state.enqueueOutboxMessage({
    chatId: 10,
    text: "due message",
    source: "test",
    createdAtMs: now - 1000,
    nextAttemptAtMs: now - 500,
  });
  state.enqueueOutboxMessage({
    chatId: 10,
    text: "future message",
    source: "test",
    createdAtMs: now,
    nextAttemptAtMs: now + 60_000,
  });

  const due = state.listDueOutboxMessages({ chatId: 10, nowMs: now, limit: 10 });
  assert.equal(due.length, 1);
  assert.equal(due[0]?.id, dueId);

  state.markOutboxAttempt(dueId, {
    lastError: "temporary_error",
    nextAttemptAtMs: now + 5_000,
  });

  const afterAttempt = state.listOutboxMessages(10, 10).find((item) => item.id === dueId);
  assert.ok(afterAttempt);
  assert.equal(afterAttempt?.attempts, 1);
  assert.equal(afterAttempt?.lastError, "temporary_error");
  assert.ok((afterAttempt?.nextAttemptAtMs ?? 0) >= now + 4_900);

  const moved = state.moveOutboxToDeadLetter(dueId, {
    failureReason: "max_retries",
    failedAtMs: now + 10_000,
  });
  assert.equal(moved, true);

  const dead = state.listOutboxDeadLetter(10, 10);
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.failureReason, "max_retries");
  assert.equal(dead[0]?.chatId, 10);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("sqlite state store persists runtime chat/global settings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-sqlite-state-runtime-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const state = new SqliteStateStore(dbPath);
  await state.init();

  const now = Date.now();
  state.replaceChatRuntimeSettings([
    {
      chatId: 777,
      activeAgent: "admin",
      aiShellMode: true,
      ecoMode: false,
      safeMode: true,
      openAiModel: "gpt-4o-mini",
      adminMode: true,
      updatedAtMs: now,
    },
  ]);

  const rows = state.listChatRuntimeSettings(777);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.chatId, 777);
  assert.equal(rows[0]?.activeAgent, "admin");
  assert.equal(rows[0]?.aiShellMode, true);
  assert.equal(rows[0]?.ecoMode, false);
  assert.equal(rows[0]?.safeMode, true);
  assert.equal(rows[0]?.openAiModel, "gpt-4o-mini");
  assert.equal(rows[0]?.adminMode, true);

  state.upsertGlobalRuntimeSettings({
    panicMode: true,
    updatedAtMs: now + 1000,
  });
  const global = state.getGlobalRuntimeSettings();
  assert.ok(global);
  assert.equal(global?.panicMode, true);

  await fs.rm(tempDir, { recursive: true, force: true });
});
