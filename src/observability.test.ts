import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "./observability.js";

test("observability counters and timings", () => {
  const metrics = new ObservabilityService();
  metrics.increment("bridge.request", 1, { method: "POST" });
  metrics.increment("bridge.request", 2, { method: "POST" });
  metrics.timing("bridge.latency", 100);
  metrics.timing("bridge.latency", 250);

  const snapshot = metrics.snapshot();
  const counter = snapshot.counters.find((item) => item.name === "bridge.request");
  const timing = snapshot.timings.find((item) => item.name === "bridge.latency");

  assert.ok(counter);
  assert.equal(counter?.value, 3);
  assert.ok(timing);
  assert.equal(timing?.count, 2);
  assert.equal(timing?.minMs, 100);
  assert.equal(timing?.maxMs, 250);
});

test("observability reset clears counters and timings", () => {
  const metrics = new ObservabilityService();
  metrics.increment("demo.counter", 1);
  metrics.timing("demo.timing", 42);
  metrics.reset();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.length, 0);
  assert.equal(snapshot.timings.length, 0);
});
