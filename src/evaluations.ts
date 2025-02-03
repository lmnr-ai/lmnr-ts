import { Laminar } from "./laminar";
import { EvaluationDatapoint } from "./types";
import cliProgress from "cli-progress";
import { EvaluationDataset } from "./datasets";
import { otelSpanIdToUUID, otelTraceIdToUUID, Semaphore, StringUUID } from "./utils";
import { observe } from "./decorators";
import { trace } from "@opentelemetry/api";
import { SPAN_TYPE } from "./sdk/tracing/attributes";
import { InitializeOptions } from "./sdk/interfaces";

const DEFAULT_CONCURRENCY = 5;
const MAX_EXPORT_BATCH_SIZE = 64;

declare global {
  var _evaluation: Evaluation<any, any, any> | undefined;
  // If true, then we need to set the evaluation globally without running it
  var _set_global_evaluation: boolean;
}

const getEvaluationUrl = (projectId: string, evaluationId: string) => {
  return `https://www.lmnr.ai/project/${projectId}/evaluations/${evaluationId}`;
}

const getAverageScores =
  <D, T, O>(results: EvaluationDatapoint<D, T, O>[]): Record<string, number> => {
    const perScoreValues: Record<string, number[]> = {};
    for (const result of results) {
      for (const key in result.scores) {
        if (perScoreValues[key]) {
          perScoreValues[key].push(result.scores[key]);
        } else {
          perScoreValues[key] = [result.scores[key]];
        }
      }
    }

    const averageScores: Record<string, number> = {};
    for (const key in perScoreValues) {
      averageScores[key] = perScoreValues[key].reduce((a, b) => a + b, 0)
        / perScoreValues[key].length;
    }

    return averageScores;
  }

/**
 * Configuration for the Evaluator
 */
interface EvaluatorConfig {
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
}

type EvaluatorFunctionReturn = number | Record<string, number>;

/**
 * EvaluatorFunction is a function that takes the output of the executor and the
 * target data, and returns a score. The score can be a single number or a record
 * of string keys and number values. The latter is useful for evaluating
 * multiple criteria in one go instead of running multiple evaluators.
 */
type EvaluatorFunction<O, T> = (output: O, target?: T, ...args: any[]) =>
  EvaluatorFunctionReturn | Promise<EvaluatorFunctionReturn>;

/**
 * HumanEvaluator is an object to register a human evaluator. For now, it only
 * holds the queue name.
 */
export class HumanEvaluator {
  private queueName: string;

  constructor(queueName: string) {
    this.queueName = queueName;
  }
}

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
   * the executor _and_ the target data, and returns a score. The score can be a
   * single number or a dict of string keys and number values. If the score is a
   * single number, it will be named after the evaluator function. Evaluator
   * function names must contain only letters, digits, hyphens, underscores,
   * or spaces.
   */
  evaluators: Record<string, EvaluatorFunction<O, T>>;
  /**
   * [Beta] Array of instances of {@link HumanEvaluator}.
   * For now, HumanEvaluator only holds the queue name.
   */
  humanEvaluators?: HumanEvaluator[];
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
   * Deprecated. Use `groupName` instead.
   */
  groupId?: string;
  /**
   * Optional override configurations for the evaluator.
   */
  config?: EvaluatorConfig;
}

/**
 * Reports the whole progress to the console.
 */
class EvaluationReporter {
  private cliProgress: cliProgress.SingleBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic
  );
  private progressCounter: number = 0;

  constructor() { }

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
    evaluationId
  }: { averageScores: Record<string, number>, projectId: string, evaluationId: string }) {
    this.cliProgress.stop();
    process.stdout.write(`\nCheck results at ${getEvaluationUrl(projectId, evaluationId)}\n`);
    process.stdout.write('\nAverage scores:\n');
    for (const key in averageScores) {
      process.stdout.write(`${key}: ${JSON.stringify(averageScores[key])}\n`);
    }
    process.stdout.write('\n');
  }
}

class Evaluation<D, T, O> {
  private isFinished: boolean = false;
  private progressReporter: EvaluationReporter;
  private data: Datapoint<D, T>[] | EvaluationDataset<D, T>;
  private executor: (data: D, ...args: any[]) => O | Promise<O>;
  private evaluators: Record<string, EvaluatorFunction<O, T>>;
  private humanEvaluators?: HumanEvaluator[];
  private groupName?: string;
  private name?: string;
  private concurrencyLimit: number = DEFAULT_CONCURRENCY;
  private traceDisableBatch: boolean = false;
  private traceExportTimeoutMillis?: number
  private traceExportBatchSize: number = MAX_EXPORT_BATCH_SIZE;
  private uploadPromises: Promise<any>[] = [];

  constructor({
    data, executor, evaluators, humanEvaluators, groupName, name, config
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
          "Keys must only contain letters, digits, hyphens, underscores, or spaces."
        );
      }
    }

    this.progressReporter = new EvaluationReporter();
    this.data = data;
    this.executor = executor;
    this.evaluators = evaluators;
    this.humanEvaluators = humanEvaluators;
    this.groupName = groupName;
    this.name = name;
    if (config) {
      if (config.concurrencyLimit && config.concurrencyLimit < 1) {
        console.warn('concurrencyLimit must be greater than 0. Setting to default of ', DEFAULT_CONCURRENCY);
        this.concurrencyLimit = DEFAULT_CONCURRENCY;
      } else {
        this.concurrencyLimit = config.concurrencyLimit ?? DEFAULT_CONCURRENCY;
      }
      this.traceDisableBatch = config.traceDisableBatch ?? false;
      this.traceExportTimeoutMillis = config.traceExportTimeoutMillis;
      this.traceExportBatchSize = config.traceExportBatchSize ?? MAX_EXPORT_BATCH_SIZE;
    }
    if (Laminar.initialized()) {
      return;
    }
    Laminar.initialize({
      projectApiKey: config?.projectApiKey,
      baseUrl: config?.baseUrl,
      httpPort: config?.httpPort,
      grpcPort: config?.grpcPort,
      instrumentModules: config?.instrumentModules,
      disableBatch: this.traceDisableBatch,
      traceExportTimeoutMillis: this.traceExportTimeoutMillis,
      maxExportBatchSize: this.traceExportBatchSize,
    });
  }

  public async run(): Promise<void> {
    if (this.isFinished) {
      throw new Error('Evaluation is already finished');
    }

    this.progressReporter.start({ length: await this.getLength() });
    let resultDatapoints: EvaluationDatapoint<D, T, O>[];
    try {
      const evaluation = await Laminar.initEvaluation({
        groupName: this.groupName,
        name: this.name,
      });
      resultDatapoints = await this.evaluateInBatches(evaluation.id);
      const averageScores = getAverageScores(resultDatapoints);
      if (this.uploadPromises.length > 0) {
        await Promise.all(this.uploadPromises);
      }
      this.progressReporter.stop({
        averageScores,
        projectId: evaluation.projectId,
        evaluationId: evaluation.id
      });
      this.isFinished = true;
  
      await Laminar.shutdown();
    } catch (e) {
      this.progressReporter.stopWithError(e as Error);
      this.isFinished = true;
      return;
    }
  }

  public async evaluateInBatches(
    evalId: StringUUID,
  ): Promise<EvaluationDatapoint<D, T, O>[]> {
    const semaphore = new Semaphore(this.concurrencyLimit);
    const tasks: Promise<any>[] = [];

    const evaluateTask = async (datapoint: Datapoint<D, T>, index: number): Promise<[number, EvaluationDatapoint<D, T, O>]> => {
      try {
        const result = await this.evaluateDatapoint(evalId, datapoint, index);
        this.progressReporter.update(1);
        return [index, result];
      } finally {
        semaphore.release();
      }
    }

    for (let i = 0; i < await this.getLength(); i++) {
      await semaphore.acquire();
      const datapoint = Array.isArray(this.data) ? this.data[i] : await this.data.get(i);
      tasks.push(evaluateTask(datapoint, i));
    }
    const results = await Promise.all(tasks);

    return results.sort((a, b) => a[0] - b[0]).map(([_, result]) => result);
  }

  private async evaluateDatapoint(
    evalId: StringUUID,
    datapoint: Datapoint<D, T>,
    index: number
  ): Promise<EvaluationDatapoint<D, T, O>> {
    // NOTE: If you decide to move this observe to another place, note that
    //       traceId is assigned inside it for EvaluationDatapoint
    return observe({ name: "evaluation", traceType: "EVALUATION" }, async () => {
      trace.getActiveSpan()!.setAttribute(SPAN_TYPE, "EVALUATION");

      const { output, executorSpanId } = await observe(
        { name: "executor" },
        async (data: D) => {
          const executorSpanId = trace.getActiveSpan()!.spanContext().spanId;
          trace.getActiveSpan()!.setAttribute(SPAN_TYPE, "EXECUTOR");
          return {
            output: await this.executor(data),
            executorSpanId: otelSpanIdToUUID(executorSpanId)
          };
        },
        datapoint.data
      );
      const target = datapoint.target;

      let scores: Record<string, number> = {};
      for (const [evaluatorName, evaluator] of Object.entries(this.evaluators)) {
        const value = await observe(
          { name: evaluatorName },
          async (output: O, target?: T) => {
            trace.getActiveSpan()!.setAttribute(SPAN_TYPE, "EVALUATOR");
            return await evaluator(output, target);
          },
          output,
          target 
        );

        if (typeof value === 'number') {
          if (isNaN(value)) {
            throw new Error(`Evaluator ${evaluatorName} returned NaN`);
          }
          scores[evaluatorName] = value;
        } else {
          scores = { ...scores, ...value };
        }
      }

      const resultDatapoint = {
        executorOutput: output,
        data: datapoint.data,
        target,
        scores,
        traceId: otelTraceIdToUUID(trace.getActiveSpan()!.spanContext().traceId),
        // For now, all human evaluators are added to every datapoint
        // In the future, we will allow to specify which evaluators are
        // added to a particular datapoint, e.g. random sampling.
        humanEvaluators: this.humanEvaluators,
        executorSpanId,
        index
      } as EvaluationDatapoint<D, T, O>;

      const uploadPromise = Laminar.saveEvalDatapoints(evalId, [resultDatapoint], this.groupName);
      this.uploadPromises.push(uploadPromise);

      return resultDatapoint;
    });
  }

  private async getLength(): Promise<number> {
    return this.data instanceof EvaluationDataset ? await this.data.size() : this.data.length;
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
 * @param props.humanEvaluators [Beta] Array of instances of {@link HumanEvaluator}.
 * For now, HumanEvaluator only holds the queue name.
 * @param props.groupId Deprecated. Use `groupName` instead. Group name,
 * same as the feature you are evaluating in your project or application.
 * Evaluations within the same group can be visually compared.
 * Defaults to "default".
 * @param props.name Optional name of the evaluation. Used to easily identify
 * the evaluation in the group.
 * @param props.config Optional override configurations for the evaluator.
 */
export async function evaluate<D, T, O>({
  data, executor, evaluators, humanEvaluators, groupName, groupId, name, config
}: EvaluationConstructorProps<D, T, O>): Promise<void> {
  if (groupId) {
    console.warn('groupId is deprecated. Use groupName instead.');
  }
  const evaluation = new Evaluation({
    data,
    executor,
    evaluators,
    humanEvaluators,
    name,
    groupName: groupName ?? groupId,
    config
  });
  if (globalThis._set_global_evaluation) {
    globalThis._evaluation = evaluation;
  } else {
    await evaluation.run();
  }
}
