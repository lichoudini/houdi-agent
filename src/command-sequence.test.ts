import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExecCommandSequence } from "./domains/shell/command-sequence.js";

test("splits sequence by && and ;", () => {
  const seq = normalizeExecCommandSequence("git fetch && git pull; npm run build");
  assert.deepEqual(seq, ["git fetch", "git pull", "npm run build"]);
});

test("keeps separators inside quotes", () => {
  const seq = normalizeExecCommandSequence("echo 'a;b' && echo \"x&&y\"");
  assert.deepEqual(seq, ["echo 'a;b'", "echo \"x&&y\""]);
});

test("supports multiline sequence", () => {
  const seq = normalizeExecCommandSequence("pwd\nls -la\nwhoami");
  assert.deepEqual(seq, ["pwd", "ls -la", "whoami"]);
});
