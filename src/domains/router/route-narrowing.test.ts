import test from "node:test";
import assert from "node:assert/strict";
import { buildIntentRouterContextFilter } from "./context-filter.js";
import { applyIntentRouteLayers } from "./route-layers.js";
import { buildHierarchicalIntentDecision } from "./hierarchical.js";

test("context filter enforces strict exhaustion when explicit route has no overlap", () => {
  const decision = buildIntentRouterContextFilter(
    {
      chatId: 1,
      text: "eliminar archivo temporal",
      candidates: ["gmail", "connector"],
      hasMailContext: false,
      hasMemoryRecallCue: false,
    },
    {
      normalizeIntentText: (text) => text.toLowerCase().trim(),
      parseIndexedListReferenceIntent: () => ({ shouldHandle: false }),
      getIndexedListContext: () => null,
      getPendingWorkspaceDelete: () => null,
      getPendingWorkspaceDeletePath: () => null,
      getLastGmailResultsCount: () => 0,
      getLastListedFilesCount: () => 0,
      getLastConnectorContextAt: () => 0,
      connectorContextTtlMs: 60_000,
    },
  );
  assert.ok(decision);
  assert.equal(decision.strict, true);
  assert.equal(decision.exhausted, true);
  assert.deepEqual(decision.allowed, []);
});

test("route layers propagate strict exhaustion for conflicting strong cues", () => {
  const decision = applyIntentRouteLayers(["gmail", "workspace", "document"], {
    normalizedText: "gmail borrar archivo ahora",
    hasMailContext: true,
    hasMemoryRecallCue: false,
    indexedListKind: null,
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(decision);
  assert.equal(decision.strict, true);
  assert.equal(decision.exhausted, true);
  assert.deepEqual(decision.allowed, []);
});

test("route layers do not force indexed-list narrowing without explicit list reference", () => {
  const decision = applyIntentRouteLayers(["gmail", "workspace", "document", "schedule"], {
    normalizedText: "listar recordatorios",
    hasMailContext: false,
    hasMemoryRecallCue: false,
    indexedListKind: "workspace-list",
    hasPendingWorkspaceDelete: false,
  });
  assert.equal(decision, null);
});

test("route layers apply indexed-list narrowing when list reference cue exists", () => {
  const decision = applyIntentRouteLayers(["gmail", "workspace", "document", "schedule"], {
    normalizedText: "abrir 2",
    hasMailContext: false,
    hasMemoryRecallCue: false,
    indexedListKind: "workspace-list",
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(decision);
  assert.equal(decision.strict, true);
  assert.deepEqual(decision.allowed, ["workspace", "document"]);
});

test("hierarchical router returns strict exhaustion when top domain is incompatible", () => {
  const decision = buildHierarchicalIntentDecision({
    normalizedText: "eliminar archivo de workspace",
    candidates: ["gmail", "connector"],
    hasMailContext: false,
    hasMemoryRecallCue: false,
    indexedListKind: null,
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(decision);
  assert.equal(decision.strict, true);
  assert.equal(decision.exhausted, true);
  assert.deepEqual(decision.allowed, []);
});

test("context filter does not misroute 'leer correos' to workspace", () => {
  const decision = buildIntentRouterContextFilter(
    {
      chatId: 1,
      text: "leer correos",
      candidates: ["gmail", "gmail-recipients"],
      hasMailContext: true,
      hasMemoryRecallCue: false,
    },
    {
      normalizeIntentText: (text) => text.toLowerCase().trim(),
      parseIndexedListReferenceIntent: () => ({ shouldHandle: false }),
      getIndexedListContext: () => null,
      getPendingWorkspaceDelete: () => null,
      getPendingWorkspaceDeletePath: () => null,
      getLastGmailResultsCount: () => 0,
      getLastListedFilesCount: () => 0,
      getLastConnectorContextAt: () => 0,
      connectorContextTtlMs: 60_000,
    },
  );
  if (decision) {
    assert.equal(decision.exhausted, false);
    assert.ok(decision.allowed.length > 0);
    assert.ok(decision.allowed.includes("gmail"));
  } else {
    assert.equal(decision, null);
  }
});

test("route layers do not treat clock times as indexed-list references", () => {
  const decision = applyIntentRouteLayers(["gmail", "gmail-recipients", "schedule", "workspace"], {
    normalizedText: "programar correo para las 10:25 pm",
    hasMailContext: true,
    hasMemoryRecallCue: false,
    indexedListKind: "workspace-list",
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(decision);
  assert.equal(decision.strict, true);
  assert.equal(decision.exhausted, false);
  assert.ok(decision.allowed.includes("schedule"));
  assert.ok(decision.allowed.includes("gmail"));
});

test("route layers keep gmail route when sending mail that mentions news topic", () => {
  const decision = applyIntentRouteLayers(["gmail", "gmail-recipients", "web", "workspace"], {
    normalizedText: "enviar correo a nazareno con ultimas noticias de boca juniors",
    hasMailContext: true,
    hasMemoryRecallCue: false,
    indexedListKind: null,
    hasPendingWorkspaceDelete: false,
  });
  assert.ok(decision);
  assert.equal(decision.strict, true);
  assert.equal(decision.exhausted, false);
  assert.ok(decision.allowed.includes("gmail"));
  assert.ok(!decision.allowed.includes("web"));
});
