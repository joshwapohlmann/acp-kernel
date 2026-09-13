import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";
import {
  RULE_TOOL_NAME,
  DEFAULT_RULE_LIMITS,
  listRules,
  allocateRuleId,
  addRule,
  removeRule,
  clearRules,
  formatRulesForPrompt,
  RULES_USAGE_PROMPT,
} from "../src/rules.js";

test("addRule records a rule and allocates sequential ids", () => {
  const state = createInitialState();
  const r1 = addRule(state, "Always run tests before committing");
  assert.equal(r1.ok, true);
  if (!r1.ok) throw new Error("unreachable");
  assert.equal(r1.rule.id, "rule-1");
  assert.equal(r1.rule.text, "Always run tests before committing");
  const r2 = addRule(state, "  Never force-push to master  ");
  assert.equal(r2.ok, true);
  if (!r2.ok) throw new Error("unreachable");
  assert.equal(r2.rule.id, "rule-2");
  assert.equal(r2.rule.text, "Never force-push to master");
  assert.deepEqual(listRules(state).map((r) => r.id), ["rule-1", "rule-2"]);
});

test("allocateRuleId skips ids of removed rules", () => {
  const state = createInitialState();
  const a = addRule(state, "first");
  const b = addRule(state, "second");
  const c = addRule(state, "third");
  for (const r of [a, b, c]) if (!r.ok) throw new Error("unreachable");
  assert.equal(removeRule(state, b.rule.id), true);
  assert.equal(allocateRuleId(state), "rule-4");
});

test("addRule rejects empty, overlong, duplicate, and over-limit rules", () => {
  const state = createInitialState();
  assert.equal(addRule(state, "").ok, false);
  assert.equal(addRule(state, "   \n\t ").ok, false);

  const limits = { maxRuleChars: 10 };
  const tooLong = addRule(state, "x".repeat(11), limits);
  assert.equal(tooLong.ok, false);
  if (tooLong.ok) throw new Error("unreachable");
  assert.match(tooLong.error, /too long/);

  assert.equal(addRule(state, "keep this").ok, true);
  const dup = addRule(state, "keep this");
  assert.equal(dup.ok, false);
  if (dup.ok) throw new Error("unreachable");
  assert.match(dup.error, /already recorded \(rule-1\)/);

  const capped = addRule(state, "one more", { maxRules: 1 });
  assert.equal(capped.ok, false);
  if (capped.ok) throw new Error("unreachable");
  assert.match(capped.error, /limit reached \(1\)/);
});

test("default limits are sane", () => {
  assert.equal(DEFAULT_RULE_LIMITS.maxRules, 50);
  assert.equal(DEFAULT_RULE_LIMITS.maxRuleChars, 300);
});

test("removeRule removes by id and reports unknown ids", () => {
  const state = createInitialState();
  const a = addRule(state, "a");
  if (!a.ok) throw new Error("unreachable");
  addRule(state, "b");
  assert.equal(removeRule(state, "rule-99"), false);
  assert.equal(removeRule(state, a.rule.id), true);
  assert.deepEqual(listRules(state).map((r) => r.text), ["b"]);
});

test("clearRules empties the list and returns the count", () => {
  const state = createInitialState();
  addRule(state, "a");
  addRule(state, "b");
  assert.equal(clearRules(state), 2);
  assert.deepEqual(listRules(state), []);
});

test("formatRulesForPrompt renders numbered rules or empty string", () => {
  assert.equal(formatRulesForPrompt([]), "");
  const text = formatRulesForPrompt([
    { id: "rule-1", text: "first" },
    { id: "rule-2", text: "second" },
  ]);
  assert.match(text, /Recorded rules/);
  assert.match(text, /^1\. first$/m);
  assert.match(text, /^2\. second$/m);
});

test("RULES_USAGE_PROMPT instructs on what to record and brevity", () => {
  assert.match(RULES_USAGE_PROMPT, /acp_rule/);
  assert.match(RULES_USAGE_PROMPT, /SHORT/i);
});

test("rules survive on legacy states lacking the rules field", () => {
  const state = createInitialState();
  delete state.rules;
  assert.deepEqual(listRules(state), []);
  const r = addRule(state, "works on legacy state");
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(r.rule.id, "rule-1");
});

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(id: string, toolName: string, callId: string, args: string): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId: callId, text: args };
}

function toolResult(id: string, callId: string, text: string): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolCallId: callId, text };
}

const longText = "x".repeat(6000);
const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

test("acp_rule tool-call and tool-result are excluded from compression ranges by default", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", longText),
    toolCall("b", RULE_TOOL_NAME, "call1", '{"action":"add","rule":"remember X"}'),
    toolResult("c", "call1", "recorded rule-1"),
    msg("d", longText),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const config = defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  }) as Config;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const block = result.state.blocks[0]!;
  assert.ok(!block.directMessageIds.includes("b"), "acp_rule tool-call must be excluded");
  assert.ok(!block.directMessageIds.includes("c"), "acp_rule tool-result must be excluded");
  assert.ok(block.directMessageIds.includes("a"));
  assert.ok(block.directMessageIds.includes("d"));
  assert.ok(!block.effectiveMessageIds.includes("b"), "excluded from effective coverage");
  assert.ok(!block.effectiveMessageIds.includes("c"), "excluded from effective coverage");
  assert.ok(block.effectiveMessageIds.includes("a"));
  assert.ok(block.effectiveMessageIds.includes("d"));
});
