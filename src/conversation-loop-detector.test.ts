import assert from "node:assert/strict";
import test from "node:test";
import { ConversationLoopDetector } from "./conversation-loop-detector.js";

test("loop detector warns and then blocks repeated text", () => {
  const detector = new ConversationLoopDetector({
    warningThreshold: 3,
    criticalThreshold: 5,
    windowMs: 60_000,
  });

  assert.equal(detector.record(1, "hola").stuck, false);
  assert.equal(detector.record(1, "hola").stuck, false);

  const warning = detector.record(1, "hola");
  assert.equal(warning.stuck, true);
  if (warning.stuck) {
    assert.equal(warning.level, "warning");
    assert.equal(warning.detector, "repeat");
  }

  detector.record(1, "hola");
  const critical = detector.record(1, "hola");
  assert.equal(critical.stuck, true);
  if (critical.stuck) {
    assert.equal(critical.level, "critical");
    assert.equal(critical.detector, "repeat");
  }
});

test("loop detector catches ping-pong sequences", () => {
  const detector = new ConversationLoopDetector({
    warningThreshold: 4,
    criticalThreshold: 6,
    windowMs: 60_000,
  });

  detector.record(2, "A");
  detector.record(2, "B");
  detector.record(2, "A");
  const warning = detector.record(2, "B");
  assert.equal(warning.stuck, true);
  if (warning.stuck) {
    assert.equal(warning.level, "warning");
    assert.equal(warning.detector, "ping-pong");
  }
});

test("loop detector normalizes accents/case and ignores blank text", () => {
  const detector = new ConversationLoopDetector({
    warningThreshold: 3,
    criticalThreshold: 4,
    windowMs: 60_000,
  });

  assert.equal(detector.record(3, "   ").stuck, false);
  assert.equal(detector.record(3, "Árbol").stuck, false);
  assert.equal(detector.record(3, "arbol").stuck, false);
  const warning = detector.record(3, "ARBOL");
  assert.equal(warning.stuck, true);
  if (warning.stuck) {
    assert.equal(warning.detector, "repeat");
    assert.equal(warning.level, "warning");
  }
});
