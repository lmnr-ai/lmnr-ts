import { LaminarClient } from "@lmnr-ai/client";
import { Datapoint, type Dataset, type StringUUID } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { loadFromPaths, printToConsole, writeToFile } from "../../utils/file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();
const DEFAULT_DATASET_PULL_BATCH_SIZE = 100;
const DEFAULT_DATASET_PUSH_BATCH_SIZE = 100;

const printDataset = (dataset: Dataset): void => {
  console.log(
    renderTable(
      ["ID", "Created At", "Name"],
      [[dataset.id, new Date(dataset.createdAt).toISOString(), dataset.name]],
    ),
  );
};

interface DatasetIdentifierOptions extends GlobalOpts {
  name?: string;
  id?: StringUUID;
}

/** Throw on the name/id mutual-exclusion rule. The wrapper renders the error. */
function requireSingleIdentifier(opts: {
  name?: string;
  id?: StringUUID;
}): void {
  if (!opts.name && !opts.id) {
    throw new Error("Either name or id must be provided");
  }
  if (opts.name && opts.id) {
    throw new Error("Only one of name or id must be provided");
  }
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
    } else if (
      data.totalCount !== undefined &&
      currentOffset + batchSize >= data.totalCount
    ) {
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
 * Handle datasets list command. Pure handler — `withProjectClient` resolves the
 * client and owns the error envelope.
 */
export const handleDatasetsList = async (
  client: LaminarClient,
  opts: GlobalOpts,
): Promise<void> => {
  const datasets = await client.datasets.listDatasets();

  if (opts.json) {
    outputJson(datasets);
    return;
  }

  if (datasets.length === 0) {
    console.log("No datasets found.");
    return;
  }

  const rows = datasets.map((dataset) => {
    const createdAt = new Date(dataset.createdAt);
    const createdAtStr = createdAt
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);
    return [dataset.id, createdAtStr, dataset.name];
  });

  console.log(renderTable(["ID", "Created At", "Name"], rows));
  console.log(`\nTotal: ${datasets.length} dataset(s)\n`);
};

/** `lmnr-cli dataset get <dataset-id>` */
export const handleDatasetGet = async (
  client: LaminarClient,
  datasetId: StringUUID,
  opts: GlobalOpts,
): Promise<void> => {
  const dataset = await client.datasets.getById(datasetId);
  if (opts.json) {
    outputJson(dataset);
    return;
  }
  printDataset(dataset);
};

/** `lmnr-cli dataset create <name>` */
export const handleDatasetCreate = async (
  client: LaminarClient,
  name: string,
  opts: GlobalOpts,
): Promise<void> => {
  const dataset = await client.datasets.create(name);
  if (opts.json) {
    outputJson(dataset);
    return;
  }
  logger.info(`Created dataset "${dataset.name}" (${dataset.id}).`);
};

/** `lmnr-cli dataset update <dataset-id> --name <name>` */
export const handleDatasetUpdate = async (
  client: LaminarClient,
  datasetId: StringUUID,
  opts: GlobalOpts & { name: string },
): Promise<void> => {
  const dataset = await client.datasets.update(datasetId, opts.name);
  if (opts.json) {
    outputJson(dataset);
    return;
  }
  logger.info(`Updated dataset "${dataset.name}" (${dataset.id}).`);
};

/** `lmnr-cli dataset delete <dataset-id>` */
export const handleDatasetDelete = async (
  client: LaminarClient,
  datasetId: StringUUID,
  opts: GlobalOpts,
): Promise<void> => {
  const dataset = await client.datasets.delete(datasetId);
  if (opts.json) {
    outputJson(dataset);
    return;
  }
  logger.info(
    `Deleted dataset "${dataset.name}" (${dataset.id}) and its datapoints.`,
  );
};

/**
 * Handle datasets push command.
 */
export const handleDatasetsPush = async (
  client: LaminarClient,
  paths: string[],
  opts: DatasetIdentifierOptions & {
    recursive?: boolean;
    batchSize?: number;
  },
): Promise<void> => {
  requireSingleIdentifier(opts);

  const data = await loadFromPaths(paths, opts.recursive);

  if (data.length === 0) {
    throw new Error("No data to push");
  }

  const identifier = opts.name ? { name: opts.name } : { id: opts.id };

  const result = await client.datasets.push({
    points: data,
    ...identifier,
    batchSize: opts.batchSize ?? DEFAULT_DATASET_PUSH_BATCH_SIZE,
  });

  if (opts.json) {
    outputJson({ datasetId: result?.datasetId, count: data.length });
    return;
  }

  logger.info(
    `Pushed ${data.length} data points to dataset ${opts.name || opts.id}`,
  );
};

/**
 * Handle datasets pull command.
 */
export const handleDatasetsPull = async (
  client: LaminarClient,
  outputPath: string | undefined,
  opts: DatasetIdentifierOptions & {
    outputFormat?: "json" | "csv" | "jsonl";
    batchSize?: number;
    limit?: number;
    offset?: number;
  },
): Promise<void> => {
  requireSingleIdentifier(opts);

  const identifier = opts.name ? { name: opts.name } : { id: opts.id };

  const result = await pullAllData(
    client,
    identifier,
    opts.batchSize ?? DEFAULT_DATASET_PULL_BATCH_SIZE,
    opts.offset ?? 0,
    opts.limit,
  );

  if (outputPath) {
    await writeToFile(outputPath, result, opts.outputFormat);
    if (opts.json) {
      outputJson({ path: outputPath, count: result.length });
    } else {
      logger.info(
        `Successfully pulled ${result.length} data points to ${outputPath}`,
      );
    }
  } else {
    if (opts.json) {
      outputJson(result);
    } else {
      printToConsole(result, opts.outputFormat ?? "json");
    }
  }
};

/**
 * Import local files into a new dataset, then export the persisted datapoints.
 */
export const handleDatasetsImport = async (
  client: LaminarClient,
  name: string,
  paths: string[],
  opts: GlobalOpts & {
    outputFile: string;
    outputFormat?: "json" | "csv" | "jsonl";
    recursive?: boolean;
    batchSize?: number;
  },
): Promise<void> => {
  // Load data from input files
  const data = await loadFromPaths(paths, opts.recursive);

  if (data.length === 0) {
    throw new Error("No data to push");
  }

  // Push data to create/populate the dataset
  logger.info(`Pushing ${data.length} data points to dataset '${name}'...`);

  await client.datasets.push({
    points: data,
    name,
    batchSize: opts.batchSize ?? DEFAULT_DATASET_PUSH_BATCH_SIZE,
    createDataset: true,
  });
  logger.info(
    `Successfully pushed ${data.length} data points to dataset '${name}'`,
  );

  // Pull data back from the dataset
  logger.info(`Pulling data from dataset '${name}'...`);

  const result = await pullAllData(
    client,
    { name },
    opts.batchSize ?? DEFAULT_DATASET_PULL_BATCH_SIZE,
    0,
    undefined,
  );

  // Save to output file
  await writeToFile(opts.outputFile, result, opts.outputFormat);

  if (opts.json) {
    outputJson({ name, path: opts.outputFile, count: result.length });
  } else {
    logger.info(
      `Successfully created dataset '${name}' ` +
        `and saved ${result.length} datapoints to ${opts.outputFile}`,
    );
  }
};
