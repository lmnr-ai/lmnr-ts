import csv from 'csv-parser';
import { asString, generateCsv, mkConfig } from 'export-to-csv';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import { Datapoint } from '../evaluations';
import { initializeLogger } from '../utils';

const logger = initializeLogger();

/**
 * Check if a file has a supported extension.
 */
const isSupportedFile = (file: string): boolean => {
  const ext = path.extname(file).toLowerCase();
  return ['.json', '.csv', '.jsonl'].includes(ext);
};

/**
 * Collect all supported files from the given paths.
 * Handles both files and directories.
 */
export const collectFiles = async (
  paths: string[],
  recursive: boolean = false,
): Promise<string[]> => {
  const collectedFiles: string[] = [];

  for (const filepath of paths) {
    try {
      const stats = await fs.stat(filepath);

      if (stats.isFile()) {
        if (isSupportedFile(filepath)) {
          collectedFiles.push(filepath);
        } else {
          logger.warn(`Skipping unsupported file type: ${filepath}`);
        }
      } else if (stats.isDirectory()) {
        const entries = await fs.readdir(filepath);

        for (const entry of entries) {
          const fullPath = path.join(filepath, entry);
          const entryStats = await fs.stat(fullPath);

          if (entryStats.isFile() && isSupportedFile(fullPath)) {
            collectedFiles.push(fullPath);
          } else if (recursive && entryStats.isDirectory()) {
            const subFiles = await collectFiles([fullPath], true);
            collectedFiles.push(...subFiles);
          }
        }
      }
    } catch (error) {
      logger.warn(
        `Path does not exist or is not accessible: ${filepath}. `
        + `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return collectedFiles;
};

/**
 * Read a JSON file and return its contents.
 */
const readJsonFile = async (filepath: string): Promise<any[]> => {
  const content = await fs.readFile(filepath, 'utf-8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [parsed];
};

/**
 * Try to parse a string as JSON. If it fails, return the original string.
 */
const tryParseJson = (content: string): any => {
  // Don't try to parse if it's not a string or doesn't look like JSON
  if (typeof content !== 'string') {
    return content;
  }

  // If it doesn't start with { or [, it's probably not JSON
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return content;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    logger.debug(
      `Error parsing JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return content;
  }
};

/**
 * Parse each field in a CSV row, attempting to convert JSON strings back to objects.
 */
const parseCsvRow = (row: Record<string, string>): any => {
  const parsed: any = {};
  for (const [key, value] of Object.entries(row)) {
    parsed[key] = tryParseJson(value);
  }
  return parsed;
};

/**
 * Read a CSV file and return its contents as an array of objects.
 */
const readCsvFile = async (filepath: string): Promise<any[]> => new Promise((resolve, reject) => {
  const results: any[] = [];
  createReadStream(filepath)
    .pipe(csv())
    .on('data', (data) => results.push(parseCsvRow(data)))
    .on('end', () => resolve(results))
    .on('error', reject);
});

/**
 * Read a JSONL file and return its contents as an array of objects.
 */
async function readJsonlFile(filepath: string): Promise<any[]> {
  const content = await fs.readFile(filepath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return lines.map((line) => JSON.parse(line));
}

/**
 * Read a single file and return its contents.
 */
async function readFile(filepath: string): Promise<any[]> {
  const ext = path.extname(filepath).toLowerCase();

  if (ext === '.json') {
    return readJsonFile(filepath);
  } else if (ext === '.csv') {
    return readCsvFile(filepath);
  } else if (ext === '.jsonl') {
    return readJsonlFile(filepath);
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }
}

/**
 * Load data from all files in the specified paths.
 */
export const loadFromPaths = async <D = any, T = any>(
  paths: string[],
  recursive: boolean = false,
): Promise<Datapoint<D, T>[]> => {
  const files = await collectFiles(paths, recursive);

  if (files.length === 0) {
    logger.warn('No supported files found in the specified paths');
    return [];
  }

  logger.info(`Found ${files.length} file(s) to read`);

  const result: Datapoint<D, T>[] = [];

  for (const file of files) {
    try {
      const data = await readFile(file);
      result.push(...data);
      logger.info(`Read ${data.length} record(s) from ${file}`);
    } catch (error) {
      logger.error(
        `Error reading file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  return result;
};

/**
 * Write data to a JSON file.
 */
const writeJsonFile = async <D, T>(
  filepath: string,
  data: Datapoint<D, T>[],
): Promise<void> => {
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(filepath, content, 'utf-8');
};

/**
 * Write data to a CSV file.
 */
const writeCsvFile = async <D, T>(
  filepath: string,
  data: Datapoint<D, T>[],
): Promise<void> => {
  if (data.length === 0) {
    throw new Error('No data to write to CSV');
  }

  const formattedData = data.map(item =>
    Object.fromEntries(Object.entries(item).map(([key, value]) => [key, stringifyForCsv(value)]),
    ));

  const csvConfig = mkConfig({ useKeysAsHeaders: true });

  const csvOutput = generateCsv(csvConfig)(formattedData);
  const csvString = asString(csvOutput);

  await fs.writeFile(filepath, csvString, 'utf-8');
};

/**
 * Write data to a JSONL file.
 */
const writeJsonlFile = async <D, T>(
  filepath: string,
  data: Datapoint<D, T>[],
): Promise<void> => {
  const lines = data.map((item) => JSON.stringify(item)).join('\n');
  await fs.writeFile(filepath, lines + '\n', 'utf-8');
};

/**
 * Write data to a file based on the file extension.
 */
export const writeToFile = async <D, T>(
  filepath: string,
  data: Datapoint<D, T>[],
  format?: 'json' | 'csv' | 'jsonl',
): Promise<void> => {
  // Create parent directories if they don't exist
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });

  // Determine the format
  const ext = format ?? path.extname(filepath).slice(1);

  if (format && format !== path.extname(filepath).slice(1)) {
    logger.warn(
      `Output format ${format} does not match file extension ${path.extname(filepath).slice(1)}`,
    );
  }

  if (ext === 'json') {
    await writeJsonFile(filepath, data);
  } else if (ext === 'csv') {
    await writeCsvFile(filepath, data);
  } else if (ext === 'jsonl') {
    await writeJsonlFile(filepath, data);
  } else {
    throw new Error(`Unsupported output format: ${ext}`);
  }
};

/**
 * Convert a value to a CSV-safe string.
 * - Strings and numbers pass through
 * - null/undefined become empty strings
 * - Objects and arrays are stringified to JSON
 */
const stringifyForCsv = (value: any): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // For objects and arrays, stringify to JSON
  return JSON.stringify(value);
};

/**
 * Print data to console in the specified format.
 */
export const printToConsole = <D, T>(
  data: Datapoint<D, T>[],
  format: 'json' | 'csv' | 'jsonl' = 'json',
) => {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else if (format === 'csv') {
    if (data.length === 0) {
      logger.error('No data to print');
      return;
    }

    const formattedData = data.map(item =>
      Object.fromEntries(Object.entries(item).map(([key, value]) => [key, stringifyForCsv(value)]),
      ));

    const csvConfig = mkConfig({ useKeysAsHeaders: true });

    const csvOutput = generateCsv(csvConfig)(formattedData);
    const csvString = asString(csvOutput);
    console.log(csvString);
  } else if (format === 'jsonl') {
    data.forEach((item) => console.log(JSON.stringify(item)));
  } else {
    throw new Error(
      `Unsupported output format: ${String(format)}. `
      + "(supported formats: json, csv, jsonl)",
    );
  }
};

