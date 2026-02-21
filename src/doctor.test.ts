import test from "node:test";
import assert from "node:assert/strict";
import { formatDoctorReport } from "./doctor.js";

test("doctor report formatter prints counters and checks", () => {
  const text = formatDoctorReport({
    ok: 1,
    warn: 1,
    fail: 1,
    checks: [
      { id: "runtime.node", level: "ok", message: "node ok" },
      { id: "openai.key", level: "warn", message: "missing key", hint: "set OPENAI_API_KEY" },
      { id: "workspace.dir", level: "fail", message: "not writable" },
    ],
  });

  assert.match(text, /Doctor: ok=1 warn=1 fail=1/);
  assert.match(text, /\[OK\] runtime\.node/);
  assert.match(text, /\[WARN\] openai\.key/);
  assert.match(text, /\[FAIL\] workspace\.dir/);
  assert.match(text, /hint: set OPENAI_API_KEY/);
});
