import { test } from "node:test";
import assert from "node:assert/strict";

import { coreToOpenai, openaiToCore, type OpenAIRequestBody } from "../src/wire/openai.js";

// A thinking-mode host replays assistant turns whose `reasoning_content` is
// present but BLANK (the model emitted no chain of thought for that turn).
// Strict-echo upstreams — DeepSeek thinking mode: "The `reasoning_content` in
// the thinking mode must be passed back to the API" — reject a rebuilt request
// that lost the key while accepting a blank one, so the core round-trip must
// not turn "blank" into "absent".

const BASH_CALL = { id: "call_bash", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } } as const;
const GREP_CALL = { id: "call_grep", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } } as const;

const roundTrip = (messages: OpenAIRequestBody["messages"]) => coreToOpenai(openaiToCore({ model: "deepseek-v4-flash", messages }).msgs);

test("a blank reasoning_content field survives the round-trip", () => {
    const wire = roundTrip([
        { role: "assistant", content: ".", reasoning_content: "", tool_calls: [BASH_CALL] },
        { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
    ]);
    const assistant = wire[0]!;
    assert.equal(assistant.role, "assistant");
    assert.ok("reasoning_content" in assistant, "the key must be re-emitted");
    assert.strictEqual(assistant.reasoning_content, "");
    assert.deepStrictEqual(
        assistant.tool_calls?.map((call) => call.id),
        [BASH_CALL.id],
    );
});

test("an absent reasoning_content field is not invented", () => {
    const wire = roundTrip([{ role: "assistant", content: ".", tool_calls: [BASH_CALL] }, { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" }]);
    assert.ok(!("reasoning_content" in wire[0]!), "no field, no echo");
});

test("an inline thinking block still wins over a blank field", () => {
    const wire = roundTrip([{ role: "assistant", content: "<think>\nreasoned about it\n</think>\n\n\nanswer", reasoning_content: "" }]);
    assert.strictEqual(wire[0]!.reasoning_content, "reasoned about it");
    assert.strictEqual(wire[0]!.content, "\n\nanswer");
});

test("a text-only assistant turn keeps its blank field", () => {
    const wire = roundTrip([
        { role: "assistant", content: "hello", reasoning_content: "" },
        { role: "user", content: "again" },
    ]);
    assert.strictEqual(wire[0]!.reasoning_content, "");
    assert.strictEqual(wire[0]!.content, "hello");
});

test("a blank field does not leak onto a turn that never carried it", () => {
    const wire = roundTrip([
        { role: "assistant", content: ".", reasoning_content: "", tool_calls: [BASH_CALL] },
        { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
        { role: "assistant", content: "done" },
    ]);
    assert.strictEqual(wire[0]!.reasoning_content, "");
    assert.ok(!("reasoning_content" in wire[2]!), "the second turn keeps the key absent");
});

test("the presence marker does not enter core identity", () => {
    const blank = openaiToCore({
        model: "deepseek-v4-flash",
        messages: [
            { role: "assistant", content: ".", reasoning_content: "", tool_calls: [BASH_CALL] },
            { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
        ],
    }).msgs;
    const absent = openaiToCore({
        model: "deepseek-v4-flash",
        messages: [
            { role: "assistant", content: ".", tool_calls: [BASH_CALL] },
            { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
        ],
    }).msgs;
    assert.deepStrictEqual(
        blank.map((m) => m.id),
        absent.map((m) => m.id),
    );
});

test("parallel calls keep their call order and their results keep theirs", () => {
    const wire = roundTrip([
        { role: "assistant", content: ".", reasoning_content: "", tool_calls: [BASH_CALL, GREP_CALL] },
        { role: "tool", tool_call_id: GREP_CALL.id, content: "grep out" },
        { role: "tool", tool_call_id: BASH_CALL.id, content: "bash out" },
        { role: "user", content: "next" },
    ]);
    assert.strictEqual(wire[0]!.reasoning_content, "");
    assert.deepStrictEqual(
        wire[0]!.tool_calls?.map((call) => call.id),
        [BASH_CALL.id, GREP_CALL.id],
    );
    assert.deepStrictEqual(
        wire.slice(1, 3).map((m) => m.tool_call_id),
        [GREP_CALL.id, BASH_CALL.id],
    );
});
