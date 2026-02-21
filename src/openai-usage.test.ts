import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiUsageTracker } from "./openai-usage.js";

test("openai usage tracker aggregates by model/source", () => {
  const tracker = new OpenAiUsageTracker();

  tracker.record({
    atMs: Date.now(),
    model: "gpt-4o-mini",
    source: "ask",
    inputTokens: 120,
    outputTokens: 80,
    totalTokens: 200,
  });
  tracker.record({
    atMs: Date.now(),
    model: "gpt-4o-mini",
    source: "ask",
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 60,
  });
  tracker.record({
    atMs: Date.now(),
    model: "gpt-4.1",
    source: "shell",
    inputTokens: 200,
    outputTokens: 100,
    totalTokens: 300,
  });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.totalCalls, 3);
  assert.equal(snapshot.totalInputTokens, 360);
  assert.equal(snapshot.totalOutputTokens, 200);
  assert.equal(snapshot.totalTokens, 560);
  assert.ok(snapshot.estimatedCostUsd > 0);
  assert.equal(snapshot.byModelAndSource.length, 2);
  assert.equal(snapshot.byModelAndSource[0]?.model, "gpt-4.1");
  assert.equal(snapshot.byModelAndSource[0]?.source, "shell");
});

test("openai usage tracker reset clears events", () => {
  const tracker = new OpenAiUsageTracker();
  tracker.record({
    atMs: Date.now(),
    model: "gpt-4o-mini",
    source: "ask",
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
  });
  assert.equal(tracker.snapshot().totalCalls, 1);
  tracker.reset();
  const after = tracker.snapshot();
  assert.equal(after.totalCalls, 0);
  assert.equal(after.totalTokens, 0);
});
