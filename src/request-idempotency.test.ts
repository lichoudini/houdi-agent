import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestIdempotencyService } from "./request-idempotency.js";
import { SqliteStateStore } from "./sqlite-state-store.js";

test("idempotency stores and returns cached payloads", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-idempotency-test-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const state = new SqliteStateStore(dbPath);
  await state.init();

  const service = new RequestIdempotencyService(state, 60_000);
  const requestId = service.normalizeRequestId("req-123456");
  assert.equal(requestId, "req-123456");

  assert.equal(service.tryAcquire(1, requestId!), true);
  service.save(1, requestId!, {
    statusCode: 200,
    body: { ok: true, hello: "world" },
  });
  service.release(1, requestId!);

  const hit = service.read(1, requestId!);
  assert.ok(hit);
  assert.equal(hit?.statusCode, 200);
  assert.deepEqual(hit?.body, { ok: true, hello: "world" });

  await fs.rm(tempDir, { recursive: true, force: true });
});
