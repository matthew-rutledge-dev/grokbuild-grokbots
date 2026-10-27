import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnsetValue, readEnv } from "../src/env.js";
import { describeReadOnly, readOnlyFromEnv, resolveReadOnly } from "../src/readonly.js";

test("readEnv treats empty and literal ${...} placeholders as unset", () => {
  const env = {
    EMPTY: "",
    SPACES: "   ",
    PLACEHOLDER: "${GROKBOTS_WEBHOOK_URL}",
    PLACEHOLDER_SPACED: "  ${GROKBOTS_WEBHOOK_URL}  ",
    EMPTY_PLACEHOLDER: "${}",
    REAL: " 11111111 ",
    PARTIAL: "prefix-${X}",
  } as NodeJS.ProcessEnv;
  assert.equal(readEnv("MISSING", env), undefined);
  assert.equal(readEnv("EMPTY", env), undefined);
  assert.equal(readEnv("SPACES", env), undefined);
  assert.equal(readEnv("PLACEHOLDER", env), undefined);
  assert.equal(readEnv("PLACEHOLDER_SPACED", env), undefined);
  assert.equal(readEnv("EMPTY_PLACEHOLDER", env), undefined);
  assert.equal(readEnv("REAL", env), "11111111");
  assert.equal(readEnv("PARTIAL", env), "prefix-${X}");
  assert.equal(isUnsetValue("${GROKBOTS_WEBHOOK_KEY}"), true);
  assert.equal(isUnsetValue(undefined), true);
});

test("GROKBOTS_READ_ONLY placeholder or empty reads as off", () => {
  assert.equal(readOnlyFromEnv({ GROKBOTS_READ_ONLY: "${GROKBOTS_READ_ONLY}" }), false);
  assert.equal(readOnlyFromEnv({ GROKBOTS_READ_ONLY: "" }), false);
  assert.equal(readOnlyFromEnv({}), false);
  assert.equal(readOnlyFromEnv({ GROKBOTS_READ_ONLY: "1" }), true);
});

test("GROKBOTS_READ_ONLY fails closed on unrecognised values", () => {
  for (const v of ["enabled", "2", "maybe"]) {
    const r = resolveReadOnly(v);
    assert.equal(r.readOnly, true, v);
    assert.equal(r.source, "unrecognised");
    assert.match(r.warning ?? "", /GROKBOTS_READ_ONLY/);
  }
  for (const v of ["0", "false", "NO", "off"]) assert.equal(resolveReadOnly(v).readOnly, false, v);
  assert.match(describeReadOnly(resolveReadOnly("enabled")), /unrecognised value treated as ON/);
});
