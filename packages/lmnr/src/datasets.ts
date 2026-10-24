import { LaminarClient } from "@lmnr-ai/client";
import { type StringUUID } from "@lmnr-ai/types";

import { seededPerm } from "./datasets/prng";
import { Datapoint } from "./evaluations";

const DEFAULT_FETCH_SIZE = 25;

// A known-length, index-addressable collection of datapoints. Each subsampling
// op (`take` / `select` / `shuffle`) returns a NEW dataset, so ops chain.
export abstract class EvaluationDataset<D, T> {
  public async slice(start: number, end: number): Promise<Datapoint<D, T>[]> {
    const result = [];
    for (
      let i = Math.max(start, 0);
      i < Math.min(end, await this.size());
      i++
    ) {
      result.push(await this.get(i));
    }
    return result;
  }
  public abstract size(): Promise<number> | number;
  public abstract get(
    index: number,
  ): Promise<Datapoint<D, T>> | Datapoint<D, T>;

  // Iterate the dataset one datapoint at a time. Evals consume datasets
  // through this, never by materializing them, so a subclass that can stream
  // (see `LaminarDataset`) overrides it to keep peak memory bounded. The
  // default walks `get`, so custom datasets, which only implement the
  // size + by-index contract, keep working unchanged.
  public async *[Symbol.asyncIterator](): AsyncGenerator<Datapoint<D, T>> {
    const size = await this.size();
    for (let i = 0; i < size; i++) {
      yield await this.get(i);
    }
  }

  // The underlying remote-backed source dataset, resolved through any depth of
  // chaining. `undefined` when the dataset has no remote source.
  public sourceDataset(): LaminarDataset<D, T> | undefined {
    return undefined;
  }

  // The first `n` datapoints (or all of them if `n` exceeds the size).
  public take(n: number): EvaluationDataset<D, T> {
    return new Transformed<D, T>(this, async (base) => {
      if (!Number.isInteger(n)) {
        throw new Error(`take count ${n} is not an integer`);
      }
      const size = await base.size();
      const count = Math.max(0, Math.min(n, size));
      return Array.from({ length: count }, (_, i) => i);
    });
  }

  // Exactly these datapoints, in this order. Throws at resolve time on a
  // non-integer or out-of-range index. No clamping, no negative indices.
  public select(indices: number[]): EvaluationDataset<D, T> {
    // Snapshot the selection at call time so later mutations to the caller's
    // array can't change which indices are validated and returned.
    const selected = [...indices];
    return new Transformed<D, T>(this, async (base) => {
      const size = await base.size();
      for (const index of selected) {
        if (!Number.isInteger(index)) {
          throw new Error(`select index ${index} is not an integer`);
        }
        if (index < 0 || index >= size) {
          throw new Error(
            `select index ${index} is out of range for dataset of size ${size}`,
          );
        }
      }
      return selected;
    });
  }

  // A reproducible random permutation: the order is a pure function of
  // `(size, seed)`, so the same seed always yields the same order.
  public shuffle({
    seed = 0,
  }: {
    seed?: number;
  } = {}): EvaluationDataset<D, T> {
    return new Transformed<D, T>(this, async (base) =>
      seededPerm(await base.size(), seed),
    );
  }
}

// An immutable subsampling wrapper: an immediate `base` plus a lazy, once-only
// `resolve` that produces indices into that base, so chain orders compose.
export class Transformed<D, T> extends EvaluationDataset<D, T> {
  private base: EvaluationDataset<D, T>;
  private resolve: (base: EvaluationDataset<D, T>) => Promise<number[]>;
  private indices: number[] | null = null;
  private resolving: Promise<number[]> | null = null;

  constructor(
    base: EvaluationDataset<D, T>,
    resolve: (base: EvaluationDataset<D, T>) => Promise<number[]>,
  ) {
    super();
    this.base = base;
    this.resolve = resolve;
  }

  private resolveIndices(): Promise<number[]> {
    if (this.indices !== null) {
      return Promise.resolve(this.indices);
    }
    if (this.resolving === null) {
      // Drop a failed resolve so a transient `size`/`get` error can be retried
      // instead of poisoning every later access. Mirrors `fetchPage`.
      this.resolving = this.resolve(this.base)
        .then((indices) => {
          this.indices = indices;
          return indices;
        })
        .catch((err) => {
          this.resolving = null;
          throw err;
        });
    }
    return this.resolving;
  }

  public async size(): Promise<number> {
    return (await this.resolveIndices()).length;
  }

  public async get(index: number): Promise<Datapoint<D, T>> {
    const indices = await this.resolveIndices();
    if (index < 0 || index >= indices.length) {
      throw new Error(
        `Index ${index} is out of range for dataset of size ${indices.length}`,
      );
    }
    return await this.base.get(indices[index]);
  }

  public sourceDataset(): LaminarDataset<D, T> | undefined {
    return this.base.sourceDataset();
  }
}

export class LaminarDataset<D, T> extends EvaluationDataset<D, T> {
  // Page cache keyed by page offset. Each page's in-flight/settled fetch is
  // stored so a page is fetched at most once even under concurrent access.
  private pages: Map<number, Promise<Datapoint<D, T>[]>> = new Map();
  private len: number | null = null;
  private fetchSize: number;
  private client: LaminarClient | undefined = undefined;

  public name: string | undefined;
  public id?: StringUUID;

  constructor(
    name?: string,
    options?: { id?: StringUUID; fetchSize?: number },
  ) {
    super();
    if (!name && !options?.id) {
      throw new Error("Either name or id must be provided");
    }
    if (name && options?.id) {
      throw new Error("Only one of name or id must be provided");
    }
    this.name = name;
    this.id = options?.id;
    this.fetchSize = options?.fetchSize || DEFAULT_FETCH_SIZE;
  }

  public setClient(client: LaminarClient) {
    this.client = client;
  }

  public sourceDataset(): LaminarDataset<D, T> | undefined {
    return this;
  }

  private fetchPage(offset: number): Promise<Datapoint<D, T>[]> {
    const existing = this.pages.get(offset);
    if (existing) {
      return existing;
    }
    // Drop a failed fetch from the cache so it can be retried; a successful
    // page stays cached and is never fetched again.
    const pending = this.pullPage(offset).catch((err) => {
      this.pages.delete(offset);
      throw err;
    });
    this.pages.set(offset, pending);
    return pending;
  }

  // Fetch one page from the API WITHOUT caching it. `len` is still learned
  // from the response, since it costs nothing and is what lets the async
  // iterator know when to stop.
  private async pullPage(offset: number): Promise<Datapoint<D, T>[]> {
    if (!this.client) {
      throw new Error("Client not set");
    }
    const identifier = this.id ? { id: this.id } : { name: this.name! };
    const resp = await this.client.datasets.pull<D, T>({
      ...identifier,
      offset,
      limit: this.fetchSize,
    });
    if (this.len === null) {
      this.len = resp.totalCount;
    }
    return resp.items;
  }

  public async size(): Promise<number> {
    if (this.len === null) {
      await this.fetchPage(0);
    }
    return this.len!;
  }

  public async get(index: number): Promise<Datapoint<D, T>> {
    if (index < 0) {
      throw new Error(`Index ${index} is out of range`);
    }
    // When the length is already known, reject an out-of-range index without
    // a wasted page fetch.
    if (this.len !== null && index >= this.len) {
      throw new Error(
        `Index ${index} is out of range for dataset of size ${this.len}`,
      );
    }
    const offset = Math.floor(index / this.fetchSize) * this.fetchSize;
    const page = await this.fetchPage(offset);
    const local = index - offset;
    if (local >= page.length) {
      throw new Error(
        `Index ${index} is out of range for dataset of size ${this.len ?? "unknown"}`,
      );
    }
    return page[local];
  }

  // Stream the dataset page by page, retaining at most one page. Pages already
  // cached by `size` / `get` are served from memory; every other page is
  // pulled, yielded and then dropped, so a full eval run over a huge dataset
  // never holds more than `fetchSize` datapoints at once. `get` / `size` keep
  // their accumulate-and-cache behavior for random access.
  public async *[Symbol.asyncIterator](): AsyncGenerator<Datapoint<D, T>> {
    let offset = 0;
    let yielded = 0;
    while (this.len === null || yielded < this.len) {
      const page = await (this.pages.get(offset) ?? this.pullPage(offset));
      // An empty page before `len` datapoints have been seen means the
      // dataset shrank (or the server disagrees with its own totalCount);
      // stop rather than spin on empty pages.
      if (page.length === 0) {
        return;
      }
      yield* page;
      yielded += page.length;
      offset += this.fetchSize;
    }
  }

  /**
   * Push data from files to this dataset.
   *
   * @param {string | string[]} paths - Path(s) to files or directories containing data
   * @param {boolean} recursive - Whether to recursively read files in directories
   */
  public async push(
    paths: string | string[],
    recursive: boolean = false,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Client not set");
    }

    // Dynamic import to avoid circular dependency
    const { loadFromPaths } = await import("./cli/file-utils.js");

    const pathArray = Array.isArray(paths) ? paths : [paths];
    const data = await loadFromPaths(pathArray, recursive);

    if (data.length === 0) {
      console.warn("No data to push. Skipping");
      return;
    }

    const identifier = this.id ? { id: this.id } : { name: this.name! };
    await this.client.datasets.push({
      points: data,
      ...identifier,
    });

    console.log(`Successfully pushed ${data.length} datapoints to dataset`);
  }
}
