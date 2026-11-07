import test from "node:test";
import assert from "node:assert/strict";
import { estimateCost, aggregateEvents } from "../src/costs.js";

test("estimates cost from configured per-million rates", () => {
  assert.equal(estimateCost("m", {prompt_tokens: 1000, completion_tokens: 500}, {m:{input:1,output:2}}), 0.002);
});
test("returns null when model is unpriced", () => {
  assert.equal(estimateCost("unknown", {prompt_tokens:1}, {}), null);
});
test("aggregates usage and tracks unpriced calls", () => {
  const result = aggregateEvents([
    {model:"m",promptTokens:10,completionTokens:5,estimatedCostUsd:0.1},
    {model:"x",promptTokens:3,completionTokens:2,estimatedCostUsd:null}
  ]);
  assert.equal(result.calls, 2);
  assert.equal(result.inputTokens, 13);
  assert.equal(result.unpricedCalls, 1);
});
