import test from "node:test";
import assert from "node:assert/strict";
import { applyIntentRouteLayers } from "./route-layers.js";
import { buildIntentRouterContextFilter } from "./context-filter.js";

const candidates = ["self-maintenance", "connector", "schedule", "memory", "gmail-recipients", "gmail", "workspace", "document", "web"];

function baseDeps() {
  return {
    normalizeIntentText: (text: string) =>
      text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    parseIndexedListReferenceIntent: () => ({ shouldHandle: false }),
    getIndexedListContext: () => null,
    getPendingWorkspaceDelete: () => null,
    getPendingWorkspaceDeletePath: () => null,
    getLastGmailResultsCount: () => 0,
    getLastListedFilesCount: () => 0,
    getLastConnectorContextAt: () => 0,
    connectorContextTtlMs: 60_000,
  };
}

test("tsk delete phrase narrows to schedule across layers+context", () => {
  const text = "Eliminar tsk-mlz7y5a9-t7qltx";
  const normalizedText = baseDeps().normalizeIntentText(text);

  const layer = applyIntentRouteLayers(candidates, {
    normalizedText,
    hasMailContext: false,
    hasMemoryRecallCue: false,
    indexedListKind: null,
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(layer);
  assert.deepEqual(layer?.allowed, ["schedule"]);

  const filter = buildIntentRouterContextFilter(
    {
      chatId: 1,
      text,
      candidates,
      hasMailContext: false,
      hasMemoryRecallCue: false,
    },
    baseDeps(),
  );
  assert.ok(filter);
  assert.deepEqual(filter?.allowed, ["schedule"]);
});

test("tsk partial phrase keeps schedule priority", () => {
  const text = "Eliminar #id_tsk-mlz...";
  const normalizedText = baseDeps().normalizeIntentText(text);

  const layer = applyIntentRouteLayers(candidates, {
    normalizedText,
    hasMailContext: false,
    hasMemoryRecallCue: false,
    indexedListKind: null,
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(layer);
  assert.deepEqual(layer?.allowed, ["schedule"]);

  const filter = buildIntentRouterContextFilter(
    {
      chatId: 1,
      text,
      candidates,
      hasMailContext: false,
      hasMemoryRecallCue: false,
    },
    baseDeps(),
  );
  assert.ok(filter);
  assert.deepEqual(filter?.allowed, ["schedule"]);
});
