import test from "node:test";
import assert from "node:assert/strict";
import { resolveSecurityProfile } from "./security-profile.js";

test("safe profile by default", () => {
  const profile = resolveSecurityProfile(undefined);
  assert.equal(profile.name, "safe");
  assert.equal(profile.allowAiShell, false);
  assert.equal(profile.allowReboot, false);
  assert.equal(profile.forceApprovalMode, true);
});

test("full-control profile enables sensitive ops", () => {
  const profile = resolveSecurityProfile("full-control");
  assert.equal(profile.name, "full-control");
  assert.equal(profile.allowAiShell, true);
  assert.equal(profile.allowReboot, true);
  assert.equal(profile.forceApprovalMode, false);
});
