import assert from "node:assert/strict";
import test from "node:test";
import { ChatMessageQueue } from "./chat-message-queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("chat queue serializes tasks per chat and preserves order", async () => {
  const queue = new ChatMessageQueue();
  const events: string[] = [];

  const first = queue.enqueue(100, async () => {
    events.push("first:start");
    await sleep(40);
    events.push("first:end");
    return "first";
  });

  const second = queue.enqueue(100, async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  assert.equal(queue.getDepth(100), 2);

  const firstResult = await first;
  const secondResult = await second;

  assert.equal(firstResult.result, "first");
  assert.equal(secondResult.result, "second");
  assert.ok(secondResult.waitMs >= firstResult.waitMs);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  await sleep(0);
  assert.equal(queue.getDepth(100), 0);
  assert.deepEqual(queue.snapshot(10), []);
});

test("chat queue does not block unrelated chats", async () => {
  const queue = new ChatMessageQueue();
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = () => resolve();
  });

  const slow = queue.enqueue(200, async () => {
    await slowGate;
    return "slow";
  });

  const fast = queue.enqueue(201, async () => "fast");
  const fastResult = await fast;
  assert.equal(fastResult.result, "fast");

  releaseSlow();
  const slowResult = await slow;
  assert.equal(slowResult.result, "slow");
});
