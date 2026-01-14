import { LaminarClient } from "@lmnr-ai/client";
import { type StringUUID } from "@lmnr-ai/types";

import { Datapoint } from "../evaluations";
import { initializeLogger } from "../utils";
import { loadFromPaths, printToConsole, writeToFile } from "./file-utils";

const logger = initializeLogger();
const DEFAULT_DATASET_PULL_BATCH_SIZE = 100;
const DEFAULT_DATASET_PUSH_BATCH_SIZE = 100;

interface DatasetCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
}

/**
 * Pull all data from a dataset in batches.
 */
const pullAllData = async <D = any, T = any>(
  client: LaminarClient,
  identifier: { name?: string; id?: StringUUID },
  batchSize: number = DEFAULT_DATASET_PULL_BATCH_SIZE,
  offset: number = 0,
  limit?: number,
): Promise<Datapoint<D, T>[]> => {
  let hasMore = true;
  let currentOffset = offset;
  const stopAt = limit !== undefined ? offset + limit : undefined;

  const result: Datapoint<D, T>[] = [];

  while (hasMore && (stopAt === undefined || currentOffset < stopAt)) {
    const data = await client.datasets.pull<D, T>({
      ...identifier,
      offset: currentOffset,
      limit: batchSize,
    });

    result.push(...data.items);

    // Stop if we received no items or fewer items than requested (end of data)
    if (data.items.length === 0 || data.items.length < batchSize) {
      hasMore = false;
    } else if (stopAt !== undefined && currentOffset + batchSize >= stopAt) {
      hasMore = false;
    } else if (data.totalCount !== undefined && currentOffset + batchSize >= data.totalCount) {
      hasMore = false;
    }

    currentOffset += batchSize;
  }

  if (limit !== undefined) {
    return result.slice(0, limit);
  }

  return result;
};

/**
 * Handle datasets list command.
 */
export const handleDatasetsList = async (
  options: DatasetCommandOptions,
): Promise<void> => {
  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  try {
    const datasets = await client.datasets.listDatasets();

    if (datasets.length === 0) {
      console.log("No datasets found.");
      return;
    }

    // Print table header
    const idWidth = 36; // UUID length
    const createdAtWidth = 19; // YYYY-MM-DD HH:MM:SS format

    console.log(`\n${'ID'.padEnd(idWidth)}  ${'Created At'.padEnd(createdAtWidth)}  Name`);
    console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(createdAtWidth)}  ${'-'.repeat(20)}`);

    // Print each dataset row
    for (const dataset of datasets) {
      const createdAt = new Date(dataset.createdAt);
      const createdAtStr = createdAt.toISOString().replace('T', ' ').substring(0, 19);
      console.log(
        `${dataset.id.padEnd(idWidth)}  ${createdAtStr.padEnd(createdAtWidth)}  ${dataset.name}`,
      );
    }

    console.log(`\nTotal: ${datasets.length} dataset(s)\n`);
  } catch (error) {
    logger.error(
      `Failed to list datasets: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Handle datasets push command.
 */
export const handleDatasetsPush = async (
  paths: string[],
  options: DatasetCommandOptions & {
    name?: string;
    id?: StringUUID;
    recursive?: boolean;
    batchSize?: number;
  },
): Promise<void> => {
  if (!options.name && !options.id) {
    logger.error("Either name or id must be provided");
    return;
  }

  if (options.name && options.id) {
    logger.error("Only one of name or id must be provided");
    return;
  }

  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  const data = await loadFromPaths(paths, options.recursive);

  if (data.length === 0) {
    logger.warn("No data to push. Skipping");
    return;
  }

  const identifier = options.name ? { name: options.name } : { id: options.id };

  try {
    await client.datasets.push({
      points: data,
      ...identifier,
      batchSize: options.batchSize ?? DEFAULT_DATASET_PUSH_BATCH_SIZE,
    });
    logger.info(`Pushed ${data.length} data points to dataset ${options.name || options.id}`);
  } catch (error) {
    logger.error(
      `Failed to push dataset: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Handle datasets pull command.
 */
export const handleDatasetsPull = async (
  outputPath: string | undefined,
  options: DatasetCommandOptions & {
    name?: string;
    id?: StringUUID;
    outputFormat?: 'json' | 'csv' | 'jsonl';
    batchSize?: number;
    limit?: number;
    offset?: number;
  },
): Promise<void> => {
  if (!options.name && !options.id) {
    logger.error("Either name or id must be provided");
    return;
  }

  if (options.name && options.id) {
    logger.error("Only one of name or id must be provided");
    return;
  }

  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  const identifier = options.name ? { name: options.name } : { id: options.id };

  try {
    const result = await pullAllData(
      client,
      identifier,
      options.batchSize ?? DEFAULT_DATASET_PULL_BATCH_SIZE,
      options.offset ?? 0,
      options.limit,
    );

    if (outputPath) {
      await writeToFile(outputPath, result, options.outputFormat);
      logger.info(`Successfully pulled ${result.length} data points to ${outputPath}`);
    } else {
      printToConsole(result, options.outputFormat ?? 'json');
    }
  } catch (error) {
    logger.error(
      `Failed to pull dataset: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Handle datasets create command.
 */
export const handleDatasetsCreate = async (
  name: string,
  paths: string[],
  options: DatasetCommandOptions & {
    outputFile: string;
    outputFormat?: 'json' | 'csv' | 'jsonl';
    recursive?: boolean;
    batchSize?: number;
  },
): Promise<void> => {
  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  // Load data from input files
  const data = await loadFromPaths(paths, options.recursive);

  if (data.length === 0) {
    logger.warn("No data to push. Skipping");
    return;
  }

  // Push data to create/populate the dataset
  logger.info(`Pushing ${data.length} data points to dataset '${name}'...`);

  try {
    await client.datasets.push({
      points: data,
      name,
      batchSize: options.batchSize ?? DEFAULT_DATASET_PUSH_BATCH_SIZE,
      createDataset: true,
    });
    logger.info(`Successfully pushed ${data.length} data points to dataset '${name}'`);
  } catch (error) {
    logger.error(
      `Failed to create dataset: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Pull data back from the dataset
  logger.info(`Pulling data from dataset '${name}'...`);

  try {
    const result = await pullAllData(
      client,
      { name },
      options.batchSize ?? DEFAULT_DATASET_PULL_BATCH_SIZE,
      0,
      undefined,
    );

    // Save to output file
    await writeToFile(options.outputFile, result, options.outputFormat);

    logger.info(
      `Successfully created dataset '${name}' `
      + `and saved ${result.length} datapoints to ${options.outputFile}`,
    );
  } catch (error) {
    logger.error(
      "Failed to pull dataset after creation: "
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

