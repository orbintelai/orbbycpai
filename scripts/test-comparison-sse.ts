import assert from "node:assert/strict";
import { splitSseMessages, sseDataLine } from "../src/lib/comparison/sse";

const factualComplete = {
  type: "factual_complete",
  comparisonId: "comparison-123",
  primary: { meta: { url: "https://timescapes.co" } },
  competitors: [],
};

const stream = [
  "event: primary_started\ndata: {\"type\":\"primary_started\"}\n\n",
  `event: factual_complete\ndata: ${JSON.stringify(factualComplete)}\n\ntrailing`,
].join("");

const parsed = splitSseMessages(stream);
assert.equal(parsed.messages.length, 2, "real SSE blank lines must delimit two events");
assert.equal(parsed.remainder, "trailing", "incomplete stream content must be retained");

const payload = sseDataLine(parsed.messages[1]);
assert.ok(payload, "factual completion must expose a data line");
assert.deepEqual(JSON.parse(payload.slice(6)), factualComplete, "factual completion payload must parse unchanged");

console.log("comparison SSE parsing: passed");
