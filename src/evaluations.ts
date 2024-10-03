import { Laminar } from "./laminar";
import { EvaluationDatapoint } from "./types";
import cliProgress from "cli-progress";
import { isNumber, otelTraceIdToUUID } from "./utils";
import { observe } from "./decorators";
import { trace } from "@opentelemetry/api";
import { SPAN_TYPE } from "./sdk/tracing/attributes";
import { InitializeOptions } from "./sdk/interfaces";

const DEFAULT_BATCH_SIZE = 5;

declare global {
    var _evaluation: Evaluation<any, any, any> | undefined;
    // If true, then we need to set the evaluation globally without running it
    var _set_global_evaluation: boolean;
}

const getEvaluationUrl = (projectId: string, evaluationId: string) => {
    return `https://www.lmnr.ai/project/${projectId}/evaluations/${evaluationId}`;
}

const getAverageScores = (results: EvaluationDatapoint<any, any, any>[]): Record<string, number> => {
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
        averageScores[key] = perScoreValues[key].reduce((a, b) => a + b, 0) / perScoreValues[key].length;
    }

    return averageScores;
}

/**
 * Configuration for the Evaluator
 */
interface EvaluatorConfig {
    batchSize?: number;
    projectApiKey?: string;
    baseUrl?: string;
    httpPort?: number;
    grpcPort?: number;
    instrumentModules?: InitializeOptions['instrumentModules'];
}

export abstract class Dataset<D, T> {
    public slice(start: number, end: number): Datapoint<D, T>[] {
        const result = [];
        for (let i = Math.max(start, 0); i < Math.min(end, this.size()); i++) {
            result.push(this.get(i));
        }
        return result;
    }
    public abstract size(): number;
    public abstract get(index: number): Datapoint<D, T>;
}

/**
 * Datapoint is a single data point in the evaluation. `D` is the type of the input data, `T` is the type of the target data.
 */
export type Datapoint<D, T> = {
    /**
     * input to the executor function. Must be a record with string keys and any values.
     */
    data: Record<string, any> & D;
    /**
     * input to the evaluator function (alongside the executor output).
     * Must be a record with string keys and any values.
     */
    target: Record<string, any> & T;
}

type EvaluatorFunctionReturn = number | Record<string, number>;

/**
 * EvaluatorFunction is a function that takes the output of the executor and the target data, and returns a score.
 * The score can be a single number or a record of string keys and number values. The latter is useful for evaluating
 * multiple criteria in one go instead of running multiple evaluators.
 */
type EvaluatorFunction<O, T> = (output: O, target: T, ...args: any[]) => EvaluatorFunctionReturn | Promise<EvaluatorFunctionReturn>;

interface EvaluationConstructorProps<D, T, O> {
    /**
     * List of data points to evaluate. `data` is the input to the executor function, `target` is the input to the evaluator function.
     */
    data: (Datapoint<D, T>[]) | Dataset<D, T>;
    /**
     * The executor function. Takes the data point + any additional arguments and returns the output to evaluate.
     */
    executor: (data: D, ...args: any[]) => O | Promise<O>;
    /**
     * List of evaluator functions. Each evaluator function takes the output of the executor _and_ the target data, and returns
     * a score. The score can be a single number or a record of string keys and number values.
     * If the score is a single number, it will be named after the evaluator function. If the function is anonymous, it will be named
     * `evaluator_${index}`, where index is the index of the evaluator function in the list starting from 1.
     */
    evaluators: Record<string, EvaluatorFunction<O, T>>;
    /**
     * Optional group id of the evaluation. Defaults to "default".
     */
    groupId?: string;
    /**
     * Name of the evaluation.
     */
    name?: string;
    /**
     * Optional override configurations for the evaluator.
     */
    config?: EvaluatorConfig;
}

/**
 * Reports the whole progress to the console.
 */
class EvaluationReporter {
    private cliProgress: cliProgress.SingleBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);;
    private progressCounter: number = 0;

    constructor() {}

    public start({length}: {length: number}) {
        process.stdout.write(`\nRunning evaluation...\n\n`);
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
    public stop({averageScores, projectId, evaluationId}: {averageScores: Record<string, number>, projectId: string, evaluationId: string}) {
        this.cliProgress.stop();
        process.stdout.write(`Check progress and results at ${getEvaluationUrl(projectId, evaluationId)}\n\n`);
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
    private data: Datapoint<D, T>[] | Dataset<D, T>;
    private executor: (data: D, ...args: any[]) => O | Promise<O>;
    private evaluators: Record<string, EvaluatorFunction<O, T>>;
    private groupId?: string;
    private name?: string;
    private batchSize: number = DEFAULT_BATCH_SIZE;

    constructor({
        data, executor, evaluators, groupId, name, config
    }: EvaluationConstructorProps<D, T, O>) {
        if (Object.keys(evaluators).length === 0) {
            throw new Error('No evaluators provided');
        }

        // Validate evaluator keys
        for (const key in evaluators) {
            if (!/^[\w\s-]+$/.test(key)) {
                throw new Error(`Invalid evaluator key: "${key}". Keys must only contain letters, digits, hyphens, underscores, or spaces.`);
            }
        }

        this.progressReporter = new EvaluationReporter();
        this.data = data;
        this.executor = executor;
        this.evaluators = evaluators;
        this.groupId = groupId;
        this.name = name;
        if (config) {
            this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
        }
        Laminar.initialize({ projectApiKey: config?.projectApiKey, baseUrl: config?.baseUrl, httpPort: config?.httpPort, grpcPort: config?.grpcPort, instrumentModules: config?.instrumentModules });
    }

    public async run(): Promise<void> {
        if (this.isFinished) {
            throw new Error('Evaluation is already finished');
        }

        this.progressReporter.start({length: this.getLength()});
        let resultDatapoints: EvaluationDatapoint<D, T, O>[];
        try {
            resultDatapoints = await this.evaluateInBatches();
        } catch (e) {
            this.progressReporter.stopWithError(e as Error);
            this.isFinished = true;
            return;
        }

        const evaluation = await Laminar.createEvaluation({groupId: this.groupId, name: this.name, data: resultDatapoints});
        const averageScores = getAverageScores(resultDatapoints);
        this.progressReporter.stop({averageScores, projectId: evaluation.projectId, evaluationId: evaluation.id});
        this.isFinished = true;

        await Laminar.shutdown();
    }

    public async evaluateInBatches(): Promise<EvaluationDatapoint<D, T, O>[]> {
        const resultDatapoints: EvaluationDatapoint<D, T, O>[] = [];
        for (let i = 0; i < this.getLength(); i += this.batchSize) {
            const batch = this.data.slice(i, i + this.batchSize);
            const batchDatapoints = await this.evaluateBatch(batch);
            resultDatapoints.push(...batchDatapoints);
            this.progressReporter.update(batch.length);
        }
        return resultDatapoints;
    }
    
    private async evaluateBatch(batch: Datapoint<D, T>[]): Promise<EvaluationDatapoint<D, T, O>[]> {
        const batchPromises = batch.map(async (datapoint) => {
            let ret: EvaluationDatapoint<D, T, O> | undefined;
            
            // NOTE: If you decide to move this observe to another place, note that traceId is assigned inside it for EvaluationDatapoint
            await observe({name: "evaluation", traceType: "EVALUATION"}, async () => {
                trace.getActiveSpan()!.setAttribute(SPAN_TYPE, "EVALUATION");

                const output = await observe({name: "executor"}, async (data: Record<string, any> & D) => {
                    trace.getActiveSpan()!.setAttribute(SPAN_TYPE, "EXECUTOR");
                    return await this.executor(data);
                }, datapoint.data);
                const target = datapoint.target;
        
                let scores: Record<string, number> = {};
                for (const [evaluatorName, evaluator] of Object.entries(this.evaluators)) {
                    const value = await observe({name: evaluatorName}, async (output: O, target: T) => {
                        trace.getActiveSpan()!.setAttribute(SPAN_TYPE, "EVALUATOR");
                        return await evaluator(output, target);
                    }, output, target);
        
                    if (isNumber(value)) {
                        if (isNaN(value)) {
                            throw new Error(`Evaluator ${evaluatorName} returned NaN`);
                        }
                        scores[evaluatorName] = value;
                    } else {
                        scores = { ...scores, ...value };
                    }
                }
        
                ret = {
                    executorOutput: output,
                    data: datapoint.data,
                    target,
                    scores,
                    traceId: otelTraceIdToUUID(trace.getActiveSpan()!.spanContext().traceId),
                } as EvaluationDatapoint<D, T, O>;
            });

            return ret!;
        });
    
        const results = await Promise.all(batchPromises);
    
        return results;
    }

    private getLength() {
        return this.data instanceof Dataset ? this.data.size() : this.data.length;
    }
}

/**
 * If added to the file which is called through lmnr eval command, then simply registers the evaluation.
 * Otherwise, returns a promise which resolves when the evaluation is finished.
 * If the evaluation has no async logic, then it will be executed synchronously.
 *
 * @param props.data List of data points to evaluate. `data` is the input to the executor function, `target` is the input to the evaluator function.
 * @param props.executor The executor function. Takes the data point + any additional arguments and returns the output to evaluate.
 * @param props.evaluators Map from evaluator name to evaluator function. Each evaluator function takes the output of the executor and the target data, and returns.
 * @param props.groupId Group name which is same as the feature you are evaluating in your project or application. Defaults to "default".
 * @param props.name Optional name of the evaluation. Used to easily identify the evaluation in the group.
 * @param props.config Optional override configurations for the evaluator.
 */
export async function evaluate<D, T, O>({
    data, executor, evaluators, groupId, name, config
}: EvaluationConstructorProps<D, T, O>): Promise<void> {
    const evaluation = new Evaluation({ data, executor, evaluators, name, groupId, config });
    if (globalThis._set_global_evaluation) {
        globalThis._evaluation = evaluation;
    } else {
        await evaluation.run();
    }
}
