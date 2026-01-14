import { LaminarClient } from "@lmnr-ai/client";
import { EvaluationDatapoint } from "@lmnr-ai/types";
import { trace } from "@opentelemetry/api";
import * as cliProgress from "cli-progress";

import { EvaluationDataset, LaminarDataset } from "./datasets";
import { observe } from "./decorators";
import { Laminar } from "./laminar";
import { InitializeOptions } from "./opentelemetry-lib/interfaces";
import { HUMAN_EVALUATOR_OPTIONS, SPAN_TYPE } from "./opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "./opentelemetry-lib/tracing/context";
import {
  getFrontendUrl,
  initializeLogger,
  loadEnv,
  newUUID,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
  Semaphore,
  StringUUID,
} from "./utils";

loadEnv();

const DEFAULT_CONCURRENCY = 5;
const MAX_EXPORT_BATCH_SIZE = 64;

declare global {
  var _evaluations: Evaluation<any, any, any>[] | undefined;
  // If true, then we need to set the evaluation globally without running it
  var _set_global_evaluation: boolean;
}

const logger = initializeLogger();

const getEvaluationUrl = (
  projectId: string,
  evaluationId: string,
  baseUrl?: string,
  frontendPort?: number,
): string => {
  const url = getFrontendUrl(baseUrl, frontendPort);
  return `${url}/project/${projectId}/evaluations/${evaluationId}`;
};

const getAverageScores =
  <D, T, O>(results: EvaluationDatapoint<D, T, O>[]): Record<string, number> => {
    const perScoreValues: Record<string, number[]> = {};
    for (const result of results) {
      for (const key in result.scores) {
        const score = result.scores[key];
        if (perScoreValues[key] && score !== null) {
          perScoreValues[key].push(score);
        } else {
          perScoreValues[key] = score !== null ? [score] : [];
        }
      }
    }

    const averageScores: Record<string, number> = {};
    for (const key in perScoreValues) {
      averageScores[key] = perScoreValues[key].reduce((a, b) => a + b, 0)
        / perScoreValues[key].length;
    }

    return averageScores;
  };

/**
 * Configuration for the Evaluator
 */
interface EvaluationConfig {
  /**
   * The number of data points to evaluate in parallel at a time. Defaults to 5.
   */
  concurrencyLimit?: number;
  /**
   * The project API key to use for the evaluation. If not provided,
   * the API key from the environment variable `LMNR_PROJECT_API_KEY` will be used.
   */
  projectApiKey?: string;
  /**
   * The base URL of the Laminar API. If not provided, the default is
   * `https://api.lmnr.ai`. Useful with self-hosted Laminar instances.
   * Do NOT include the port in the URL, use `httpPort` and `grpcPort` instead.
   */
  baseUrl?: string;
  /**
   * The base HTTP URL of the Laminar API. If not provided, the default is
   * `baseUrl`. Only use this if you want to proxy HTTP requests through a different host.
   */
  baseHttpUrl?: string;
  /**
   * The HTTP port of the Laminar API. If not provided, the default is 443.
   */
  httpPort?: number;
  /**
   * The gRPC port of the Laminar API. If not provided, the default is 8443.
   */
  grpcPort?: number;
  /**
   * Object with modules to instrument. If not provided, all
   * available modules are instrumented.
   * See {@link https://docs.lmnr.ai/tracing/automatic-instrumentation}
   */
  instrumentModules?: InitializeOptions['instrumentModules'];
  /**
   * If true, then the spans will not be batched.
   */
  traceDisableBatch?: boolean;
  /**
   * Timeout for trace export. Defaults to 30_000 (30 seconds), which is over
   * the default OTLP exporter timeout of 10_000 (10 seconds).
   */
  traceExportTimeoutMillis?: number;
  /**
   * Defines default log level for SDK and all instrumentations.
   */
  logLevel?: "debug" | "info" | "warn" | "error";

  /**
   * Maximum number of spans to export at a time. Defaults to 64.
   */
  traceExportBatchSize?: number;
  /**
   * The port for the Laminar , when running self-hosted. If not provided, the default is 5667.
   */
  frontendPort?: number;
}

/**
 * Datapoint is a single data point in the evaluation. `D` is the type of the input data,
 * `T` is the type of the target data.
 */
export type Datapoint<D, T> = {
  /**
   * input to the executor function. Must be json serializable. Required.
   */
  data: D;
  /**
   * input to the evaluator function (alongside the executor output).
   * Must be json serializable.
   */
  target?: T;
  /**
   * metadata to the evaluator function. Must be json serializable.
   */
  metadata?: Record<string, any>;
  /**
   * Optional ID of the datapoint (from dataset)
   */
  id?: StringUUID;
  /**
   * Optional creation timestamp (from dataset)
   */
  createdAt?: string;
};

/**
 * HumanEvaluator is a class to register a human evaluator.
 */
export class HumanEvaluator {
  public options?: { value: number; label: string }[];

  constructor(options?: { value: number; label: string }[]) {
    this.options = options;
  }
}

export type EvaluatorFunctionReturn = number | Record<string, number>;

/**
 * EvaluatorFunction is a function that takes the output of the executor, the
 * target, and the data, and returns a score. The score can be a single number or a record
 * of string keys and number values. The latter is useful for evaluating
 * multiple criteria in one go instead of running multiple evaluators.
 */
export type EvaluatorFunction<O, T, D = any> = (output: O, target?: T, data?: D, ...args: any[]) =>
  EvaluatorFunctionReturn | Promise<EvaluatorFunctionReturn>;

interface EvaluationConstructorProps<D, T, O> {
  /**
   * List of data points to evaluate. `data` is the input to the executor function,
   * `target` is the input to the evaluator function.
   */
  data: (Datapoint<D, T>[]) | EvaluationDataset<D, T>;
  /**
   * The executor function. Takes the data point + any additional arguments
   * and returns the output to evaluate.
   */
  executor: (data: D, ...args: any[]) => O | Promise<O>;
  /**
   * Evaluator functions and names. Each evaluator function takes the output of
   * the executor, the target, and the data, and returns a score. The score can be a
   * single number or a dict of string keys and number values. If the score is a
   * single number, it will be named after the evaluator function. Evaluator
   * function names must contain only letters, digits, hyphens, underscores,
   * or spaces.
   */
  evaluators: Record<string, EvaluatorFunction<O, T, D> | HumanEvaluator>;
  /**
   * Name of the evaluation. If not provided, a random name will be assigned.
   */
  name?: string;
  /**
   * Optional group id of the evaluation. Only evaluations within the same
   * group_id can be visually compared. Defaults to "default".
   */
  groupName?: string;
  /**
   * Optional metadata to evaluation
   */
  metadata?: Record<string, any>;
  /**
   * Optional override configurations for the evaluator.
   */
  config?: EvaluationConfig;
}

interface EvaluationRunResult {
  averageScores: Record<string, number>;
  projectId: string;
  evaluationId: string;
  url: string;
  errorMessage?: string;
}

/**
 * Reports the whole progress to the console.
 */
class EvaluationReporter {
  private cliProgress: cliProgress.SingleBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic,
  );
  private progressCounter: number = 0;
  public baseUrl: string;
  public frontendPort?: number;

  constructor(
    baseUrl?: string,
    frontendPort?: number,
  ) {
    this.baseUrl = baseUrl ?? 'https://api.lmnr.ai';
    this.frontendPort = frontendPort;
  }

  public start({ length }: { length: number }) {
    this.cliProgress.start(length, 0);
  }

  public update(batchLength: number) {
    this.progressCounter += batchLength;
    this.cliProgress.update(this.progressCounter);
  }

  // Call either error or stop, not both
  public stopWithError(error: Error) {
    this.cliProgress.stop();
    process.stdout.write(`\nError: ${error.message}\n`);
  }

  // Call either error or stop, not both
  public stop({
    averageScores,
    projectId,
    evaluationId,
  }: { averageScores: Record<string, number>, projectId: string, evaluationId: string }) {
    this.cliProgress.stop();
    const url = getEvaluationUrl(projectId, evaluationId, this.baseUrl, this.frontendPort);
    process.stdout.write('\n');
    process.stdout.write('\nAverage scores:\n');
    for (const key in averageScores) {
      process.stdout.write(`${key}: ${averageScores[key]}\n`);
    }
    process.stdout.write(`\nCheck results at ${url}\n`);
  }
}

export class Evaluation<D, T, O> {
  private isFinished: boolean = false;
  private progressReporter: EvaluationReporter;
  private data: Datapoint<D, T>[] | EvaluationDataset<D, T>;
  private executor: (data: D, ...args: any[]) => O | Promise<O>;
  private evaluators: Record<string, EvaluatorFunction<O, T, D> | HumanEvaluator>;
  private groupName?: string;
  private frontendPort?: number;
  private name?: string;
  private metadata?: Record<string, any>;
  private concurrencyLimit: number = DEFAULT_CONCURRENCY;
  private traceDisableBatch: boolean = false;
  private traceExportTimeoutMillis?: number;
  private traceExportBatchSize: number = MAX_EXPORT_BATCH_SIZE;
  private uploadPromises: Promise<any>[] = [];
  private client: LaminarClient;

  constructor({
    data, executor, evaluators, groupName, name, metadata, config,
  }: EvaluationConstructorProps<D, T, O>) {
    if (Object.keys(evaluators).length === 0) {
      throw new Error('No evaluators provided');
    }

    const evaluatorNameRegex = /^[\w\s-]+$/;
    // Validate evaluator keys
    for (const key in evaluators) {
      if (!evaluatorNameRegex.test(key)) {
        throw new Error(
          `Invalid evaluator key: "${key}".` +
          "Keys must only contain letters, digits, hyphens, underscores, or spaces.",
        );
      }
    }

    this.frontendPort = config?.frontendPort;
    this.progressReporter = new EvaluationReporter(config?.baseUrl, config?.frontendPort);
    this.data = data;
    this.executor = executor;
    this.evaluators = evaluators;
    this.groupName = groupName;
    this.metadata = metadata;
    this.name = name;

    if (config) {
      if (config.concurrencyLimit !== undefined && config.concurrencyLimit < 1) {
        logger.warn(
          `concurrencyLimit must be greater than 0. Setting to default of ${DEFAULT_CONCURRENCY}`,
        );
        this.concurrencyLimit = DEFAULT_CONCURRENCY;
      } else {
        this.concurrencyLimit = config.concurrencyLimit ?? DEFAULT_CONCURRENCY;
      }
      this.traceDisableBatch = config.traceDisableBatch ?? false;
      this.traceExportTimeoutMillis = config.traceExportTimeoutMillis;
      this.traceExportBatchSize = config.traceExportBatchSize ?? MAX_EXPORT_BATCH_SIZE;
    }

    if (Laminar.initialized()) {
      this.client = new LaminarClient({
        baseUrl: Laminar.getHttpUrl(),
        projectApiKey: Laminar.getProjectApiKey(),
      });
      if (config?.projectApiKey && config.projectApiKey !== Laminar.getProjectApiKey()) {
        logger.warn('Laminar was already initialized with a different project API key. ' +
          'Ignoring the project API key from the evaluation config.');
      }
      return;
    }

    const key = config?.projectApiKey ?? process.env.LMNR_PROJECT_API_KEY;
    if (key === undefined) {
      throw new Error(
        'Please initialize the Laminar object with your project API key ' +
        'or set the LMNR_PROJECT_API_KEY environment variable',
      );
    }

    const url = config?.baseUrl ?? process?.env?.LMNR_BASE_URL ?? 'https://api.lmnr.ai';
    const httpUrl = config?.baseHttpUrl ?? url;
    const httpPort = config?.httpPort ?? (
      httpUrl.match(/:\d{1,5}$/g)
        ? parseInt(httpUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const urlWithoutSlash = httpUrl.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    const baseHttpUrl = `${urlWithoutSlash}:${httpPort}`;

    this.client = new LaminarClient({
      baseUrl: baseHttpUrl,
      projectApiKey: key,
    });

    Laminar.initialize({
      projectApiKey: config?.projectApiKey,
      baseUrl: url,
      baseHttpUrl,
      httpPort,
      grpcPort: config?.grpcPort,
      instrumentModules: config?.instrumentModules,
      disableBatch: this.traceDisableBatch,
      traceExportTimeoutMillis: this.traceExportTimeoutMillis,
      maxExportBatchSize: this.traceExportBatchSize,
    });
  }

  public async run(): Promise<EvaluationRunResult> {
    if (this.isFinished) {
      throw new Error('Evaluation is already finished');
    }
    if (this.data instanceof LaminarDataset) {
      this.data.setClient(this.client);
      // Fetch dataset ID if not already set
      if (!this.data.id) {
        try {
          const datasets = await this.client.datasets.getDatasetByName(
            (this.data as any).name,
          );
          if (datasets.length > 0) {
            this.data.id = datasets[0].id;
          } else {
            logger.warn(`Dataset ${(this.data as any).name} not found`);
          }
        } catch (error) {
          // Backward compatibility with old Laminar API (self-hosted)
          logger.warn(
            `Error getting dataset ${(this.data).name}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    let resultDatapoints: EvaluationDatapoint<D, T, O>[];
    try {
      const evaluation = await this.client.evals.init(this.name, this.groupName, this.metadata);
      const url = getEvaluationUrl(
        evaluation.projectId,
        evaluation.id,
        this.progressReporter.baseUrl,
        this.frontendPort,
      );
      process.stdout.write(`\nCheck results at ${url}\n`);
      this.progressReporter.start({ length: await this.getLength() });

      resultDatapoints = await this.evaluateInBatches(evaluation.id);
      const averageScores = getAverageScores(resultDatapoints);
      if (this.uploadPromises.length > 0) {
        await Promise.all(this.uploadPromises);
      }
      this.progressReporter.stop({
        averageScores,
        projectId: evaluation.projectId,
        evaluationId: evaluation.id,
      });
      this.isFinished = true;

      await Laminar.shutdown();
      return {
        averageScores,
        projectId: evaluation.projectId,
        evaluationId: evaluation.id,
        url,
      };
    } catch (e) {
      this.progressReporter.stopWithError(e as Error);
      this.isFinished = true;
      return {
        averageScores: {},
        projectId: '',
        evaluationId: '',
        url: '',
        errorMessage: (e instanceof Error) ? e.message : String(e),
      };
    }
  }

  public async evaluateInBatches(
    evalId: StringUUID,
  ): Promise<EvaluationDatapoint<D, T, O>[]> {
    const semaphore = new Semaphore(this.concurrencyLimit);
    const tasks: Promise<any>[] = [];

    const evaluateTask = async (
      datapoint: Datapoint<D, T>,
      index: number,
    ): Promise<[number, EvaluationDatapoint<D, T, O>]> => {
      try {
        const result = await this.evaluateDatapoint(evalId, datapoint, index);
        this.progressReporter.update(1);
        return [index, result];
      } finally {
        semaphore.release();
      }
    };

    for (let i = 0; i < await this.getLength(); i++) {
      await semaphore.acquire();
      const datapoint = Array.isArray(this.data) ? this.data[i] : await this.data.get(i);
      tasks.push(evaluateTask(datapoint, i));
    }
    const results = await Promise.all(tasks);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return results.sort((a, b) => a[0] - b[0]).map(([, result]) => result);
  }

  private async evaluateDatapoint(
    evalId: StringUUID,
    datapoint: Datapoint<D, T>,
    index: number,
  ): Promise<EvaluationDatapoint<D, T, O>> {
    return observe({ name: "evaluation", traceType: "EVALUATION" }, async () => {

      trace.getSpan(LaminarContextManager.getContext())!.setAttribute(SPAN_TYPE, "EVALUATION");
      const executorSpan = Laminar.startSpan({
        name: "executor",
        input: datapoint.data,
      });
      executorSpan.setAttribute(SPAN_TYPE, "EXECUTOR");
      const executorSpanId = otelSpanIdToUUID(executorSpan.spanContext().spanId);
      const datapointId = newUUID();
      const partialDatapoint = {
        id: datapointId,
        data: datapoint.data,
        target: datapoint.target,
        metadata: datapoint.metadata,
        traceId: otelTraceIdToUUID(
          trace.getSpan(LaminarContextManager.getContext())!.spanContext().traceId,
        ),
        executorSpanId,
        index,
      } as EvaluationDatapoint<D, T, O>;

      // Add dataset link if data is from LaminarDataset
      if (
        this.data instanceof LaminarDataset
        && this.data.id && datapoint.id && datapoint.createdAt
      ) {
        partialDatapoint.datasetLink = {
          datasetId: this.data.id,
          datapointId: datapoint.id,
          createdAt: datapoint.createdAt,
        };
      }

      // first create the datapoint in the database and await
      await this.client.evals.saveDatapoints({
        evalId,
        datapoints: [partialDatapoint],
        groupName: this.groupName,
      });

      const output = await Laminar.withSpan(
        executorSpan,
        async () => {
          const result = await this.executor(datapoint.data);
          Laminar.setSpanOutput(result);
          return result;
        },
        true,
      );
      const target = datapoint.target;

      let scores: Record<string, number | null> = {};
      for (const [evaluatorName, evaluator] of Object.entries(this.evaluators)) {
        const value = await observe(
          { name: evaluatorName },
          async (output: O, target?: T, data?: D) => {
            if (evaluator instanceof HumanEvaluator) {
              const activeSpan = trace.getSpan(LaminarContextManager.getContext());
              if (activeSpan) {
                activeSpan.setAttribute(SPAN_TYPE, "HUMAN_EVALUATOR");
                if (evaluator.options) {
                  activeSpan.setAttribute(
                    HUMAN_EVALUATOR_OPTIONS,
                    JSON.stringify(evaluator.options),
                  );
                }
              }
              return null;
            } else {
              const activeSpan = trace.getSpan(LaminarContextManager.getContext());
              if (activeSpan) {
                activeSpan.setAttribute(SPAN_TYPE, "EVALUATOR");
              }
              return await evaluator(output, target, data);
            }
          },
          output,
          datapoint.target,
          datapoint.data,
        );

        if (evaluator instanceof HumanEvaluator) {
          scores[evaluatorName] = null;
          continue;
        }

        if (typeof value === "number") {
          if (isNaN(value)) {
            throw new Error(`Evaluator ${evaluatorName} returned NaN`);
          }
          scores[evaluatorName] = value;
        } else if (value !== null) {
          scores = { ...scores, ...value };
        }
      }

      const resultDatapoint = {
        id: datapointId,
        executorOutput: output,
        data: datapoint.data,
        target,
        metadata: datapoint.metadata,
        scores,
        traceId: otelTraceIdToUUID(
          trace.getSpan(LaminarContextManager.getContext())!.spanContext().traceId,
        ),
        executorSpanId,
        index,
      } as EvaluationDatapoint<D, T, O>;

      // Add dataset link if data is from LaminarDataset
      if (this.data instanceof LaminarDataset
        && this.data.id && datapoint.id && datapoint.createdAt
      ) {
        resultDatapoint.datasetLink = {
          datasetId: this.data.id,
          datapointId: datapoint.id,
          createdAt: datapoint.createdAt,
        };
      }

      const uploadPromise = this.client.evals.saveDatapoints({
        evalId,
        datapoints: [resultDatapoint],
        groupName: this.groupName,
      });
      this.uploadPromises.push(uploadPromise);

      return resultDatapoint;
    });
  }

  private async getLength(): Promise<number> {
    return this.data instanceof EvaluationDataset ? await this.data.size() : this.data.length;
  }

  public setFrontendPort(port: number) {
    this.frontendPort = port;
    this.progressReporter.frontendPort = port;
  }
}

/**
 * If added to the file which is called through lmnr eval command, then simply
 * registers the evaluation. Otherwise, returns a promise which resolves when
 * the evaluation is finished. If the evaluation has no async logic, then it
 * will be executed synchronously.
 *
 * @param props.data List of data points to evaluate. `data` is the input to the
 * executor function, `target` is the input to the evaluator function.
 * @param props.executor The executor function. Takes the data point + any
 * additional arguments and returns the output to evaluate.
 * @param props.evaluators Map from evaluator name to evaluator function. Each
 * evaluator function takes the output of the executor and the target data, and
 * returns.
 * @param props.name Optional name of the evaluation. Used to easily identify
 * the evaluation in the group.
 * @param props.metadata Optional metadata to evaluation
 * @param props.config Optional override configurations for the evaluator.
 */
export async function evaluate<D, T, O>({
  data, executor, evaluators, groupName, name, metadata, config,
}: EvaluationConstructorProps<D, T, O>): Promise<EvaluationRunResult | undefined> {
  const evaluation = new Evaluation<D, T, O>({
    data,
    executor,
    evaluators,
    name,
    groupName,
    metadata,
    config,
  });
  if (globalThis._set_global_evaluation) {
    // TODO: if we load files concurrently, we need to use a mutex to protect
    // concurrent writes to globalThis._evaluations
    globalThis._evaluations = [...(globalThis._evaluations ?? []), evaluation];
  } else {
    return await evaluation.run();
  }
}
