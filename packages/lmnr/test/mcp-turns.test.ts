import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TurnTracker } from "../src/integrations/mcp/turns";

const GAP_MS = 20_000;
const TEN_MINUTES_MS = 10 * 60_000;

void describe("MCP TurnTracker", () => {
  void it("joins the session's turn within the gap and starts a new one after it", () => {
    let now = 0;
    const tracker = new TurnTracker(() => now);

    assert.equal(tracker.begin("s", GAP_MS), undefined);
    const turn = tracker.start("s", "a".repeat(32));
    tracker.end(turn);

    now += GAP_MS;
    const joined = tracker.begin("s", GAP_MS);
    assert.equal(joined, turn);
    tracker.end(turn);

    now += GAP_MS + 1;
    assert.equal(tracker.begin("s", GAP_MS), undefined);
  });

  void it("a call that outlived its turn does not release the turn that replaced it", () => {
    let now = 0;
    const tracker = new TurnTracker(() => now);

    // A call whose handler hangs past the stale in-flight limit.
    assert.equal(tracker.begin("s", GAP_MS), undefined);
    const hung = tracker.start("s", "a".repeat(32));

    now += TEN_MINUTES_MS + 1;
    assert.equal(tracker.begin("s", GAP_MS), undefined);
    const current = tracker.start("s", "b".repeat(32));
    assert.equal(tracker.begin("s", GAP_MS), current);
    assert.equal(current.inFlight, 2);

    // The hung call finally ends: the new turn's calls are still in flight.
    tracker.end(hung);
    assert.equal(current.inFlight, 2);

    // So a call long after the last activity still joins the in-flight turn.
    now += GAP_MS * 2;
    assert.equal(tracker.begin("s", GAP_MS)?.traceId, "b".repeat(32));
  });
});
