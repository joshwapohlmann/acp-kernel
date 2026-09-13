import type { CompressionState, RuleRecord } from "./types.js";

/** Canonical model-facing tool name for rule recording (adapters may rename). */
export const RULE_TOOL_NAME = "acp_rule";

export interface RuleLimits {
  /** Maximum number of rules per session. Default 50. */
  maxRules: number;
  /** Maximum characters per rule text (after trim). Default 300. */
  maxRuleChars: number;
}

export const DEFAULT_RULE_LIMITS: RuleLimits = Object.freeze({
  maxRules: 50,
  maxRuleChars: 300,
});

export type AddRuleResult =
  | { ok: true; rule: RuleRecord }
  | { ok: false; error: string };

export function listRules(state: CompressionState): RuleRecord[] {
  return state.rules ?? [];
}

const RULE_ID_RE = /^rule-(\d+)$/;

export function allocateRuleId(state: CompressionState): string {
  let max = 0;
  for (const rule of state.rules ?? []) {
    const m = RULE_ID_RE.exec(rule.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `rule-${max + 1}`;
}

export function addRule(
  state: CompressionState,
  text: string,
  limits: Partial<RuleLimits> = {},
): AddRuleResult {
  const maxRules = limits.maxRules ?? DEFAULT_RULE_LIMITS.maxRules;
  const maxRuleChars = limits.maxRuleChars ?? DEFAULT_RULE_LIMITS.maxRuleChars;
  const clean = text.trim();
  if (clean.length === 0) {
    return { ok: false, error: "rule text must not be empty" };
  }
  if (clean.length > maxRuleChars) {
    return {
      ok: false,
      error: `rule too long (${clean.length} chars, limit ${maxRuleChars}) — keep rules short and principle-level`,
    };
  }
  const existing = state.rules ?? [];
  const dup = existing.find((r) => r.text === clean);
  if (dup) {
    return { ok: false, error: `identical rule already recorded (${dup.id})` };
  }
  if (existing.length >= maxRules) {
    return {
      ok: false,
      error: `rule limit reached (${maxRules}) — remove stale rules first`,
    };
  }
  const rule: RuleRecord = { id: allocateRuleId(state), text: clean };
  state.rules = [...existing, rule];
  return { ok: true, rule };
}

export function removeRule(state: CompressionState, id: string): boolean {
  const existing = state.rules ?? [];
  const next = existing.filter((r) => r.id !== id);
  if (next.length === existing.length) return false;
  state.rules = next;
  return true;
}

export function clearRules(state: CompressionState): number {
  const count = (state.rules ?? []).length;
  state.rules = [];
  return count;
}

/** Render active rules for system-prompt injection. Empty string when none. */
export function formatRulesForPrompt(rules: RuleRecord[]): string {
  if (rules.length === 0) return "";
  const lines = rules.map((r, i) => `${i + 1}. ${r.text}`);
  return [
    "## Recorded rules (acp_rule)",
    "Persistent reminders that always stay in effect (never compressed away):",
    ...lines,
  ].join("\n");
}

/** Model-facing usage instructions for the acp_rule tool. Adapters append this
 *  to the system prompt when the feature is enabled. */
export const RULES_USAGE_PROMPT = [
  "## Recording persistent rules (acp_rule)",
  'Use the acp_rule tool to record short, principle-level reminders that must survive context compression. Record them at the moment they happen, do not batch later.',
  "Record:",
  "- lessons the user specifically calls out or repeatedly emphasizes",
  "- behaviors the user explicitly asks you to remember or follow",
  "- major pitfalls you personally hit (root cause + how to avoid) that are worth remembering long-term",
  "Rules must be SHORT and PRINCIPLE-based: one line each, no anecdotes, no verbose detail.",
  'Check existing rules before recording to avoid duplicates; use action "list" to review and action "remove" to drop stale ones.',
].join("\n");
