import { LaminarClient } from './client';
import { Datapoint } from './evaluations';
import { StringUUID } from './utils';

const DEFAULT_FETCH_SIZE = 25;

export abstract class EvaluationDataset<D, T> {
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

export class LaminarDataset<D, T> extends EvaluationDataset<D, T> {
  private fetchedItems: Datapoint<D, T>[] = [];
  private len: number | null = null;
  private offset: number = 0;
  private fetchSize: number;
  private client: LaminarClient | undefined = undefined;

  public name: string | undefined;
  public id?: StringUUID;

  constructor(name?: string, options?: { id?: StringUUID; fetchSize?: number }) {
    super();
    if (!name && !options?.id) {
      throw new Error('Either name or id must be provided');
    }
    if (name && options?.id) {
      throw new Error('Only one of name or id must be provided');
    }
    this.name = name;
    this.id = options?.id;
    this.fetchSize = options?.fetchSize || DEFAULT_FETCH_SIZE;
  }

  public setClient(client: LaminarClient) {
    this.client = client;
  }

  private async fetchBatch() {
    if (!this.client) {
      throw new Error('Client not set');
    }
    const identifier = this.id ? { id: this.id } : { name: this.name! };
    const resp = await this.client.datasets.pull<D, T>({
      ...identifier,
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

  /**
   * Push data from files to this dataset.
   *
   * @param {string | string[]} paths - Path(s) to files or directories containing data
   * @param {boolean} recursive - Whether to recursively read files in directories
   */
  public async push(paths: string | string[], recursive: boolean = false): Promise<void> {
    if (!this.client) {
      throw new Error('Client not set');
    }

    // Dynamic import to avoid circular dependency
    const { loadFromPaths } = await import('./cli/file-utils');

    const pathArray = Array.isArray(paths) ? paths : [paths];
    const data = await loadFromPaths<D, T>(pathArray, recursive);

    if (data.length === 0) {
      console.warn('No data to push. Skipping');
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
