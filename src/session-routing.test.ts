import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSlackSessionKey,
  chatIdFromSessionKey,
  deriveSessionKeyFromBridgePayload,
  normalizeSessionKey,
} from "./session-routing.js";

test("normalizeSessionKey validates and normalizes", () => {
  assert.equal(normalizeSessionKey("SLACK:CHAN_1:THREAD:MAIN"), "slack:chan_1:thread:main");
  assert.equal(normalizeSessionKey(""), null);
  assert.equal(normalizeSessionKey("  "), null);
  assert.equal(normalizeSessionKey("**bad**"), null);
});

test("chatIdFromSessionKey is stable", () => {
  const key = "slack:c123:thread:main";
  const one = chatIdFromSessionKey(key);
  const two = chatIdFromSessionKey(key);
  assert.equal(one, two);
  assert.ok(one > 0);
});

test("buildSlackSessionKey builds canonical key", () => {
  assert.equal(buildSlackSessionKey("C123", "171.55"), "slack:c123:thread:171.55");
  assert.equal(buildSlackSessionKey("C123", ""), "slack:c123:thread:main");
  assert.equal(buildSlackSessionKey("", "171.55"), null);
});

test("deriveSessionKeyFromBridgePayload prefers explicit key", () => {
  const key = deriveSessionKeyFromBridgePayload({
    source: "slack:message",
    sessionKey: "custom:key:1",
    channel: "C123",
    threadTs: "1.2",
  });
  assert.equal(key, "custom:key:1");
});

test("deriveSessionKeyFromBridgePayload builds from source metadata", () => {
  const slackKey = deriveSessionKeyFromBridgePayload({
    source: "slack:message",
    channel: "C123",
    threadTs: "171.55",
  });
  assert.equal(slackKey, "slack:c123:thread:171.55");

  const telegramKey = deriveSessionKeyFromBridgePayload({
    source: "telegram:message",
    chatId: 123,
  });
  assert.equal(telegramKey, "telegram:chat:123");
});
