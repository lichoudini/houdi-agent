import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SelfSkillStore } from "./store.js";

test("SelfSkillStore agrega, lista y elimina instrucciones", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-selfskill-"));
  try {
    const store = new SelfSkillStore({ workspaceDir: tmpDir });
    const first = await store.appendInstruction("responder con pasos concretos");
    await store.appendInstruction("confirmar antes de borrar archivos");
    assert.match(first.entry, /\[#sk-[a-z0-9]+\]/i);

    const listed = await store.listInstructions();
    assert.equal(listed.entries.length, 2);
    assert.match(listed.entries[0] ?? "", /responder con pasos concretos/);
    assert.match(listed.entries[1] ?? "", /confirmar antes de borrar archivos/);

    const firstId = (listed.entries[0] ?? "").match(/\[#([a-z0-9][a-z0-9_-]{2,40})\]/i)?.[1] ?? "";
    assert.ok(firstId.length > 0);

    const removedById = await store.removeInstruction(firstId);
    assert.equal(removedById.removedIndex, 1);
    assert.match(removedById.removedEntry, /responder con pasos concretos/);
    assert.equal(removedById.remaining, 1);

    const removedLast = await store.removeInstruction(-1);
    assert.equal(removedLast.removedIndex, 1);
    assert.match(removedLast.removedEntry, /confirmar antes de borrar archivos/);
    assert.equal(removedLast.remaining, 0);

    const listedAfter = await store.listInstructions();
    assert.equal(listedAfter.entries.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
