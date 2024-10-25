import { Datapoint } from './evaluations';
import { Laminar as L } from './laminar';

const DEFAULT_FETCH_SIZE = 25;

export abstract class Dataset<D, T> {
  public async slice(start: number, end: number): Promise<Datapoint<D, T>[]> {
    const result = [];
    for (let i = Math.max(start, 0); i < Math.min(end, await this.size()); i++) {
      result.push(await this.get(i));
    }
    return result;
  }
  public abstract size(): Promise<number> | number;
  public abstract get(index: number): Promise<Datapoint<D, T>> | Datapoint<D, T>;
}

export class LaminarDataset<D, T> extends Dataset<D, T> {
  private fetchedItems: Datapoint<D, T>[] = [];
  private len: number | null = null;
  private offset: number = 0;
  private fetchSize: number;
  private name: string;

  constructor(name: string, fetchSize?: number) {
    super();
    this.name = name;
    this.fetchSize = fetchSize || DEFAULT_FETCH_SIZE;
  }

  private async fetchBatch() {
    // Commented out until we allow users to set log level
    // console.debug(`Dataset ${this.name}. Fetching batch from ${this.offset} to ${this.offset + this.fetchSize}`);
    const resp = await L.getDatapoints<D, T>({
      datasetName: this.name,
      offset: this.offset,
      limit: this.fetchSize,
    });
    this.fetchedItems = this.fetchedItems.concat(resp.items);
    this.offset = this.fetchedItems.length;
    if (this.len === null) {
      this.len = resp.totalCount;
    }
  }

  public async size(): Promise<number> {
    if (this.len === null) {
      await this.fetchBatch();
    }
    return this.len!;
  }
  public async get(index: number): Promise<Datapoint<D, T>> {
    if (index >= this.fetchedItems.length) {
      await this.fetchBatch();
    }
    return this.fetchedItems[index];
  }
}
