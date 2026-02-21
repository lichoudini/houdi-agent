import test from "node:test";
import assert from "node:assert/strict";
import { IntentSemanticRouter } from "./intent-semantic-router.js";

test("routes gmail intent", () => {
  const router = new IntentSemanticRouter();
  const decision = router.route("enviame un email a juan con asunto reunion");
  assert.ok(decision);
  assert.equal(decision.handler, "gmail");
  assert.ok(decision.score >= 0.2);
});

test("routes workspace intent", () => {
  const router = new IntentSemanticRouter();
  const decision = router.route("crea una carpeta en workspace y mueve archivo");
  assert.ok(decision);
  assert.equal(decision.handler, "workspace");
});
