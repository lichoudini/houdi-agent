import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EmailRecipientsSqliteService } from "./email-recipients-sqlite.js";

test("email recipients sqlite migrate and CRUD", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-recipients-test-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const jsonPath = path.join(tempDir, "recipients.json");

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        recipients: [
          {
            chatId: 1,
            name: "Ana",
            nameKey: "ana",
            email: "ana@example.com",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const service = new EmailRecipientsSqliteService({ dbPath });
  await service.load();
  const migrated = await service.migrateFromJson(jsonPath);
  assert.equal(migrated, 1);

  const list1 = service.list(1);
  assert.equal(list1.length, 1);
  assert.equal(list1[0]?.email, "ana@example.com");

  const upsertResult = service.upsert({
    chatId: 1,
    name: "Ana Maria",
    nameKey: "ana_maria",
    email: "ana.maria@example.com",
  });
  assert.equal(upsertResult.created, true);

  const deleted = service.deleteByNameKey(1, "ana");
  assert.ok(deleted);
  assert.equal(deleted?.nameKey, "ana");

  const remaining = service.list(1);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.nameKey, "ana_maria");

  await fs.rm(tempDir, { recursive: true, force: true });
});
