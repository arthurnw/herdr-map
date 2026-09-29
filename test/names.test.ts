import assert from "node:assert/strict";
import { test } from "node:test";
import { agentNameError } from "../shared/names.ts";

test("agentNameError accepts herdr-style names", () => {
  assert.equal(agentNameError("lead", []), undefined);
  assert.equal(agentNameError("a", []), undefined);
  assert.equal(agentNameError("auth-fix_2", ["lead"]), undefined);
  assert.equal(agentNameError("a".repeat(32), []), undefined);
});

test("agentNameError rejects names herdr would refuse", () => {
  for (const bad of ["", "Lead", "2fast", "-x", "has space", "a".repeat(33), "x;rm", undefined, 3]) {
    assert.ok(agentNameError(bad, []), `${String(bad)} should be refused`);
  }
});

test("agentNameError refuses a name another agent has", () => {
  assert.match(agentNameError("lead", ["stylist", "lead"]) ?? "", /already named lead/);
});
