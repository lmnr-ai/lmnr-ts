import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type StringUUID } from "@lmnr-ai/types";
import nock from "nock";

import {
  type EveEval,
  type EveEvalResult,
  type EveEvalTarget,
  LaminarReporter,
} from "../src/integrations/eve";

type RequestBody = Record<string, any>;

const NOCK_URL = "https://api.lmnr.ai:443";
const PROJECT_API_KEY = "test-api-key";
const MOCK_EVAL_ID: StringUUID = "12345678-1234-1234-1234-123456789abc";

const DATAPOINT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mockInit = (capture?: (body: RequestBody) => void) =>
  nock(NOCK_URL)
    .post("/v1/evals", (body: RequestBody) => {
      capture?.(body);
      return true;
    })
    .reply(200, {
      id: MOCK_EVAL_ID,
      createdAt: new Date().toISOString(),
      groupId: "group-123",
      name: "eve-run",
      projectId: "project-123",
    });

const makeReporter = () =>
  new LaminarReporter({ name: "eve-run", projectApiKey: PROJECT_API_KEY });

void describe("LaminarReporter for eve evals", () => {
  void beforeEach(() => {
    process.env.LMNR_PROJECT_API_KEY = PROJECT_API_KEY;
  });

  void afterEach(() => {
    nock.cleanAll();
  });

  void it("creates one Laminar evaluation on run start with eve metadata", async () => {
    let body: RequestBody = {};
    const scope = mockInit((b) => (body = b));

    const reporter = makeReporter();
    const evals: EveEval[] = [{ id: "a" }, { id: "b" }];
    const target: EveEvalTarget = { name: "weather-agent" };
    await reporter.onRunStart(evals, target);

    assert.strictEqual(body.name, "eve-run");
    assert.strictEqual(body.metadata.source, "eve");
    assert.strictEqual(body.metadata.targetName, "weather-agent");
    assert.strictEqual(body.metadata.evalCount, 2);
    scope.done();
  });

  void it("reports a graded eval as create + update datapoint calls", async () => {
    const initScope = mockInit();

    let createBody: RequestBody = {};
    const createScope = nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        createBody = b;
        return true;
      })
      .reply(200, {});

    let updateBody: RequestBody = {};
    const updateScope = nock(NOCK_URL)
      .post(
        new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/${DATAPOINT_ID_RE.source.slice(1, -1)}`),
        (b: RequestBody) => {
          updateBody = b;
          return true;
        },
      )
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], { name: "agent" });

    const result: EveEvalResult = {
      id: "brooklyn-forecast",
      name: "Brooklyn forecast",
      input: "What is the weather in Brooklyn?",
      output: "It is sunny.",
      target: "sunny",
      status: "passed",
      passed: true,
      checks: [
        { name: "relevance", score: 0.9 },
        { name: "no-refusal", gate: true, passed: true },
      ],
    };
    await reporter.onEvalComplete(result);

    // create datapoint
    assert.strictEqual(createBody.points.length, 1);
    const point = createBody.points[0];
    assert.ok(DATAPOINT_ID_RE.test(point.id));
    assert.strictEqual(point.data, "What is the weather in Brooklyn?");
    assert.strictEqual(point.target, "sunny");
    assert.strictEqual(point.index, 0);
    assert.strictEqual(point.metadata.name, "Brooklyn forecast");
    assert.strictEqual(point.metadata.status, "passed");
    assert.strictEqual(point.metadata.passed, true);

    // update datapoint: soft score kept, gate became binary gate:<name>
    assert.deepStrictEqual(updateBody.scores, {
      relevance: 0.9,
      "gate:no-refusal": 1,
    });
    assert.strictEqual(updateBody.executorOutput, "It is sunny.");

    initScope.done();
    createScope.done();
    updateScope.done();
  });

  void it("encodes a failed gate as a zero binary score", async () => {
    mockInit();
    nock(NOCK_URL).post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`).reply(200, {});
    let updateBody: RequestBody = {};
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`), (b: RequestBody) => {
        updateBody = b;
        return true;
      })
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await reporter.onEvalComplete({
      id: "a",
      passed: false,
      status: "failed",
      checks: [{ name: "must-answer", gate: true, passed: false }],
    });

    assert.deepStrictEqual(updateBody.scores, { "gate:must-answer": 0 });
  });

  void it("passes through pre-aggregated scores and increments index", async () => {
    mockInit();
    const indices: number[] = [];
    nock(NOCK_URL)
      .post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`, (b: RequestBody) => {
        indices.push(b.points[0].index);
        return true;
      })
      .twice()
      .reply(200, {});
    nock(NOCK_URL)
      .post(new RegExp(`/v1/evals/${MOCK_EVAL_ID}/datapoints/.+`))
      .twice()
      .reply(200, {});

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }, { id: "b" }], {});
    await reporter.onEvalComplete({ id: "a", scores: { accuracy: 1 } });
    await reporter.onEvalComplete({ id: "b", scores: { accuracy: 0 } });

    assert.deepStrictEqual(indices, [0, 1]);
  });

  void it("does not throw when onRunStart failed and onEvalComplete runs", async () => {
    nock(NOCK_URL).post("/v1/evals").reply(500, "boom");

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    // No eval/datapoint endpoint mocked — if the reporter tried to call it,
    // nock would throw on an unmocked request. It must short-circuit instead.
    await assert.doesNotReject(() => reporter.onEvalComplete({ id: "a" }));
    assert.doesNotThrow(() => reporter.onRunComplete());
  });

  void it("swallows datapoint errors so a bad eval never breaks the run", async () => {
    mockInit();
    nock(NOCK_URL).post(`/v1/evals/${MOCK_EVAL_ID}/datapoints`).reply(500, "nope");

    const reporter = makeReporter();
    await reporter.onRunStart([{ id: "a" }], {});
    await assert.doesNotReject(() => reporter.onEvalComplete({ id: "a", scores: {} }));
  });
});
