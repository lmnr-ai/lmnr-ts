import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { LaminarClient } from "@lmnr-ai/client";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import { EvaluationDataset, LaminarDataset } from "../src/datasets";
import { seededPerm } from "../src/datasets/prng";
import { Datapoint, evaluate, Laminar } from "../src/index";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

// A tiny in-memory dataset over a fixed array. Records every by-index access so
// tests can assert fetch/scan behavior without any HTTP.
class ArrayDataset<D, T> extends EvaluationDataset<D, T> {
  public getCalls: number[] = [];
  constructor(private items: Datapoint<D, T>[]) {
    super();
  }
  public size(): number {
    return this.items.length;
  }
  public get(index: number): Datapoint<D, T> {
    this.getCalls.push(index);
    return this.items[index];
  }
}

// Datapoints whose `data` equals their index, so a resulting `data` sequence is
// directly comparable to the expected index sequence.
const indexed = (n: number): ArrayDataset<number, number> =>
  new ArrayDataset(Array.from({ length: n }, (_, i) => ({ data: i })));

const dataOf = async (
  ds: EvaluationDataset<number, number>,
): Promise<number[]> => {
  const size = await ds.size();
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    out.push((await ds.get(i)).data);
  }
  return out;
};

void describe("EvaluationDataset subsampling", () => {
  void describe("take", () => {
    void it("returns the first n datapoints", async () => {
      const ds = indexed(10).take(3);
      assert.strictEqual(await ds.size(), 3);
      assert.deepStrictEqual(await dataOf(ds), [0, 1, 2]);
    });

    void it("returns all when n exceeds the size", async () => {
      const ds = indexed(4).take(100);
      assert.strictEqual(await ds.size(), 4);
      assert.deepStrictEqual(await dataOf(ds), [0, 1, 2, 3]);
    });

    void it("does not scan the whole dataset", async () => {
      const base = indexed(1000);
      const taken = base.take(3);
      await dataOf(taken);
      // Only the 3 taken indices are ever fetched from the base.
      assert.deepStrictEqual(base.getCalls, [0, 1, 2]);
    });

    void it("returns a new dataset, leaving the original unchanged", async () => {
      const base = indexed(5);
      base.take(2);
      assert.deepStrictEqual(await dataOf(base), [0, 1, 2, 3, 4]);
    });
  });

  void describe("select", () => {
    void it("returns exactly those datapoints in the given order", async () => {
      const ds = indexed(10).select([4, 1, 7]);
      assert.strictEqual(await ds.size(), 3);
      assert.deepStrictEqual(await dataOf(ds), [4, 1, 7]);
    });

    void it("throws on an out-of-range index, naming the index and size", async () => {
      const ds = indexed(5).select([0, 9]);
      await assert.rejects(
        async () => {
          await ds.size();
        },
        /select index 9 is out of range for dataset of size 5/,
      );
    });

    void it("throws on a negative index", async () => {
      const ds = indexed(5).select([-1]);
      await assert.rejects(
        async () => {
          await ds.size();
        },
        /select index -1 is out of range for dataset of size 5/,
      );
    });
  });

  void describe("filter", () => {
    void it("keeps only matching datapoints, order preserved", async () => {
      const ds = indexed(10).filter((dp) => dp.data % 2 === 0);
      assert.deepStrictEqual(await dataOf(ds), [0, 2, 4, 6, 8]);
    });

    void it("supports an async predicate", async () => {
      const ds = indexed(6).filter(
        (dp) => Promise.resolve(dp.data > 2),
      );
      assert.deepStrictEqual(await dataOf(ds), [3, 4, 5]);
    });

    void it("scans once and caches the surviving indices", async () => {
      const base = indexed(8);
      const filtered = base.filter((dp) => dp.data % 2 === 0);
      await dataOf(filtered);
      await dataOf(filtered);
      // One full scan (indices 0..7) plus the two survivor reads per dataOf
      // pass. No second scan.
      const scan = [0, 1, 2, 3, 4, 5, 6, 7];
      const survivors = [0, 2, 4, 6];
      assert.deepStrictEqual(base.getCalls, [
        ...scan,
        ...survivors,
        ...survivors,
      ]);
    });
  });

  void describe("shuffle", () => {
    void it("permutes the datapoints (a new dataset; original unchanged)", async () => {
      const base = indexed(10);
      const shuffled = base.shuffle({ seed: 42 });
      assert.deepStrictEqual(await dataOf(shuffled), seededPerm(10, 42));
      assert.deepStrictEqual(await dataOf(base), Array.from({ length: 10 }, (_, i) => i));
    });

    void it("same seed yields the same order across two fresh chains", async () => {
      const a = indexed(20).shuffle({ seed: 7 });
      const b = indexed(20).shuffle({ seed: 7 });
      assert.deepStrictEqual(await dataOf(a), await dataOf(b));
    });

    void it("different seed yields a different order", async () => {
      const a = indexed(20).shuffle({ seed: 7 });
      const b = indexed(20).shuffle({ seed: 8 });
      assert.notDeepStrictEqual(await dataOf(a), await dataOf(b));
    });
  });

  void describe("chain composition", () => {
    void it("select after take indexes into the taken subset", async () => {
      const ds = indexed(10).take(5).select([4, 0]);
      assert.deepStrictEqual(await dataOf(ds), [4, 0]);
    });

    void it("shuffle().take() differs from take().shuffle()", async () => {
      const shuffleThenTake = indexed(50).shuffle({ seed: 3 }).take(10);
      const takeThenShuffle = indexed(50).take(10).shuffle({ seed: 3 });
      // shuffle-then-take = a random 10 out of 50; take-then-shuffle = a
      // permutation of the first 10 only.
      assert.deepStrictEqual(await dataOf(shuffleThenTake), seededPerm(50, 3).slice(0, 10));
      assert.deepStrictEqual(
        await dataOf(takeThenShuffle),
        seededPerm(10, 3),
      );
      assert.notDeepStrictEqual(
        await dataOf(shuffleThenTake),
        await dataOf(takeThenShuffle),
      );
    });

    void it("filter then take composes", async () => {
      const ds = indexed(20)
        .filter((dp) => dp.data % 3 === 0)
        .take(2);
      assert.deepStrictEqual(await dataOf(ds), [0, 3]);
    });
  });

  void describe("resolution caching", () => {
    void it("resolves the index list once even under concurrent access", async () => {
      const base = indexed(4);
      const filtered = base.filter((dp) => dp.data >= 0);
      // Two concurrent size() calls must trigger only one resolve.
      const [s1, s2] = await Promise.all([filtered.size(), filtered.size()]);
      assert.strictEqual(s1, 4);
      assert.strictEqual(s2, 4);
      // The base was scanned exactly once (4 reads), proving the resolve ran
      // once despite two concurrent size() calls.
      const scanReads = base.getCalls.filter((i) => i < 4).length;
      assert.strictEqual(scanReads, 4);
    });
  });
});

void describe("seededPerm parity vectors", () => {
  interface PermCase {
    n: number;
    seed: number;
    permutation: number[];
  }
  const vectors: PermCase[] = JSON.parse(
    readFileSync(
      join(__dirname, "data", "dataset", "seeded_perm_cases.json"),
      "utf-8",
    ),
  ).cases;

  for (const { n, seed, permutation } of vectors) {
    void it(`n=${n} seed=${seed}`, () => {
      assert.deepStrictEqual(seededPerm(n, seed), permutation);
    });
  }
});

void describe("LaminarDataset page-cached random access", () => {
  // Fake client that pages over a synthetic dataset and counts pulls.
  const makeFakeClient = (total: number, pullCounter: { n: number }) =>
    ({
      datasets: {
        pull: ({ offset, limit }: { offset: number; limit: number }) => {
          pullCounter.n += 1;
          const items: Datapoint<number, number>[] = [];
          for (let i = offset; i < Math.min(offset + limit, total); i++) {
            items.push({ data: i, id: `id-${i}` as any, createdAt: `t-${i}` });
          }
          return Promise.resolve({ items, totalCount: total });
        },
      },
    }) as unknown as LaminarClient;

  void it("returns the correct datapoint for an arbitrary index", async () => {
    const counter = { n: 0 };
    const ds = new LaminarDataset<number, number>("d", { fetchSize: 3 });
    ds.setClient(makeFakeClient(10, counter));
    assert.strictEqual((await ds.get(7)).data, 7);
    assert.strictEqual((await ds.get(9)).data, 9);
    assert.strictEqual((await ds.get(0)).data, 0);
  });

  void it("fetches each page at most once", async () => {
    const counter = { n: 0 };
    const ds = new LaminarDataset<number, number>("d", { fetchSize: 3 });
    ds.setClient(makeFakeClient(10, counter));
    // Indices 6,7,8 all live in the page at offset 6.
    await ds.get(6);
    await ds.get(7);
    await ds.get(8);
    assert.strictEqual(counter.n, 1);
    // A different page adds exactly one fetch.
    await ds.get(0);
    assert.strictEqual(counter.n, 2);
  });

  void it("backfills size from the first fetched page", async () => {
    const counter = { n: 0 };
    const ds = new LaminarDataset<number, number>("d", { fetchSize: 4 });
    ds.setClient(makeFakeClient(13, counter));
    assert.strictEqual(await ds.size(), 13);
  });

  void it("throws on an out-of-range index", async () => {
    const counter = { n: 0 };
    const ds = new LaminarDataset<number, number>("d", { fetchSize: 4 });
    ds.setClient(makeFakeClient(5, counter));
    await assert.rejects(() => ds.get(10), /out of range/);
  });

  void it("forwards setClient and sourceDataset through a chain", async () => {
    const counter = { n: 0 };
    const base = new LaminarDataset<number, number>("d", { fetchSize: 3 });
    const chained = base.shuffle({ seed: 1 }).take(2);
    // sourceDataset resolves the underlying LaminarDataset through the chain.
    assert.strictEqual(chained.sourceDataset(), base);
    // setClient forwards down to the source so a chained dataset can fetch.
    chained.setClient(makeFakeClient(6, counter));
    const out = await dataOf(chained);
    assert.strictEqual(out.length, 2);
  });
});

// Integration: a chained remote dataset still produces a dataset-link on the
// recorded datapoints (client injection + source-id resolution survive the
// wrappers). Uses nock cassettes + an in-memory span exporter, matching the
// prior art in evaluate.test.ts.
void describe("evaluate over a chained LaminarDataset", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
  });

  void afterEach(() => {
    exporter.reset();
    nock.cleanAll();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("carries the dataset-link through shuffle().take()", async () => {
    const baseUrl = "https://api.lmnr.ai";
    const mockEvalId = "00000000-0000-0000-0000-000000000000";
    const datasetId = "11111111-1111-1111-1111-111111111111";

    // Page pull for the dataset (single page covers all 3 datapoints).
    nock(baseUrl)
      .get("/v1/datasets/datapoints")
      .query(true)
      .reply(200, {
        items: [
          { data: "d0", id: "dp-0", createdAt: "2024-01-01T00:00:00Z" },
          { data: "d1", id: "dp-1", createdAt: "2024-01-02T00:00:00Z" },
          { data: "d2", id: "dp-2", createdAt: "2024-01-03T00:00:00Z" },
        ],
        totalCount: 3,
      });

    nock(baseUrl)
      .post("/v1/evals")
      .reply(200, { id: mockEvalId, projectId: "mock-project-id" });

    const savedDatapoints: Record<string, any>[] = [];
    nock(baseUrl)
      .post(`/v1/evals/${mockEvalId}/datapoints`, (body: Record<string, any>) => {
        for (const p of body.points ?? []) {
          savedDatapoints.push(p);
        }
        return true;
      })
      .times(4)
      .reply(200, {});

    // id provided so no getDatasetByName round-trip is needed.
    const dataset = new LaminarDataset<string, string>(undefined, {
      id: datasetId,
    })
      .shuffle({ seed: 42 })
      .take(2);

    await evaluate({
      data: dataset,
      executor: (data) => data,
      evaluators: { echo: (output, _t, data) => (output === data ? 1 : 0) },
      config: { projectApiKey: "test" },
    });

    await Laminar.flush();

    const linked = savedDatapoints.filter((p) => p.datasetLink);
    assert.ok(linked.length > 0, "expected at least one datapoint with a datasetLink");
    for (const p of linked) {
      assert.strictEqual(p.datasetLink.datasetId, datasetId);
      assert.ok(p.datasetLink.datapointId);
      assert.ok(p.datasetLink.createdAt);
    }
  });
});
