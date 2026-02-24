import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmailRecipientsSqliteService } from "../../email-recipients-sqlite.js";
import { GmailRecipientsManager } from "./recipients-manager.js";

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("gmail recipients manager cleans legacy noisy Carla rows on list", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-recipients-manager-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const store = new EmailRecipientsSqliteService({ dbPath });
  await store.load();

  const chatId = 8482923834;
  store.upsert({
    chatId,
    name: "Carla carla",
    nameKey: "carla carla",
    email: "carla@empresa.com",
  });
  store.upsert({
    chatId,
    name: "Carla con carla.ops",
    nameKey: "carla con carla ops",
    email: "carla.ops@empresa.com",
  });
  store.upsert({
    chatId,
    name: "Carla",
    nameKey: "carla",
    email: "carla.ops@empresa.com",
  });
  store.upsert({
    chatId,
    name: "alias",
    nameKey: "alias",
    email: "usuario@example.com",
  });

  const manager = new GmailRecipientsManager(store, normalizeIntentText);
  const rows = manager.list(chatId);
  assert.equal(rows.length, 2);
  const byName = new Map(rows.map((row) => [row.name, row]));
  assert.equal(byName.get("Carla")?.email, "carla.ops@empresa.com");
  assert.equal(byName.has("alias"), true);

  await fs.rm(tempDir, { recursive: true, force: true });
});
