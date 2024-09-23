import { Laminar } from "./laminar";
import { CreateEvaluationResponse, EvaluationDatapoint } from "./types";
import cliProgress from "cli-progress";
import { isNumber } from "./utils";

const DEFAULT_BATCH_SIZE = 5;

declare global {
    var _evaluation: Evaluation<any, any, any> | undefined;
    // If true, then we need to set the evaluation globally without running it
    var _set_global_evaluation: boolean;
}

const getEvaluationUrl = (projectId: string, evaluationId: string) => {
    return `https://www.lmnr.ai/project/${projectId}/evaluations/${evaluationId}`;
}

/**
 * Configuration for the Evaluator
 */
interface EvaluatorConfig {
    batchSize?: number;
    projectApiKey?: string;
    baseUrl?: string;
    httpPort?: number;
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
    evaluators: EvaluatorFunction<O, T>[];
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

    public start({name, projectId, id, length}: {name: string, projectId: string, id: string, length: number}) {
        process.stdout.write(`\nRunning evaluation ${name}...\n\n`);
        process.stdout.write(`Check progress and results at ${getEvaluationUrl(projectId, id)}\n\n`);
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
    public stop(averageScores: Record<string, number>) {
        this.cliProgress.stop();
        process.stdout.write('\nAverage scores:\n');
        for (const key in averageScores) {
            process.stdout.write(`${key}: ${averageScores[key]}\n`);
        }
        process.stdout.write('\n');
    }
}

class Evaluation<D, T, O> {
    private isFinished: boolean = false;
    private name?: string;
    private progressReporter: EvaluationReporter;
    private data: Datapoint<D, T>[] | Dataset<D, T>;
    private executor: (data: D, ...args: any[]) => O | Promise<O>;
    private evaluators: Record<string, EvaluatorFunction<O, T>>;
    private evaluatorNames: string[];
    private batchSize: number = DEFAULT_BATCH_SIZE;

    /**
     * Create a new evaluation and prepare data.
     * @param name Name of the evaluation.
     * @param props.data List of data points to evaluate. `data` is the input to the executor function, `target` is the input to the evaluator function.
     * @param props.executor The executor function. Takes the data point + any additional arguments and returns the output to evaluate.
     * @param props.evaluators List of evaluator functions. Each evaluator function takes the output of the executor and the target data, and returns.
     * @param props.config Optional override configurations for the evaluator.
     */
    constructor({
        data, executor, evaluators, name, config
    }: EvaluationConstructorProps<D, T, O>) {
        this.name = name;
        this.progressReporter = new EvaluationReporter();
        this.data = data;
        this.executor = executor;
        this.evaluators = Object.fromEntries(evaluators.map((e, i) => [e.name.length > 0 ? e.name : `evaluator_${i + 1}`, e]));
        this.evaluatorNames = evaluators.map((e, i) => e.name.length > 0 ? e.name : `evaluator_${i + 1}`);
        if (config) {
            this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
        }
        Laminar.initialize({ projectApiKey: config?.projectApiKey, baseUrl: config?.baseUrl, httpPort: config?.httpPort, instrumentModules: {} });
    }

    /** 
     * Runs the evaluation.
     *
     * Creates a new evaluation.
     * Evaluates data points in batches of `batchSize`. The executor function is called on each data point
     * to get the output, and then evaluate it by each evaluator function.
     */
    public async run(): Promise<void> {
        if (this.isFinished) {
            throw new Error('Evaluation is already finished');
        }

        const evaluation = await Laminar.createEvaluation(this.name);
        this.progressReporter.start({name: evaluation.name, projectId: evaluation.projectId, id: evaluation.id, length: this.getLength()});
        try {
            await this.evaluateInBatches(evaluation);
        } catch (e) {
            await Laminar.updateEvaluationStatus(evaluation.id, 'Error');
            this.progressReporter.stopWithError(e as Error);
            this.isFinished = true;
            return;
        }

        // If we update with status "Finished", we expect averageScores to be not empty
        const updatedEvaluation = await Laminar.updateEvaluationStatus(evaluation.id, 'Finished');
        this.progressReporter.stop(updatedEvaluation.averageScores!);
        this.isFinished = true;
    }

    // TODO: Calculate duration of the evaluation and add it to the summary
    public async evaluateInBatches(evaluation: CreateEvaluationResponse): Promise<void> {
        for (let i = 0; i < this.getLength(); i += this.batchSize) {
            const batch = this.data.slice(i, i + this.batchSize);
            try {
                const results = await this.evaluateBatch(batch);

                // TODO: This must happen on the background, while the next batch is being evaluated
                // If we do this, then we can calculate the duration of the evaluation and add it to the summary
                await Laminar.postEvaluationResults(evaluation.id, results);
            } catch (e) {
                console.error(`Error evaluating batch: ${e}`);
            } finally {
                // Update progress regardless of success
                this.progressReporter.update(batch.length);
            }
        }
    }
    
    private async evaluateBatch(batch: Datapoint<D, T>[]): Promise<EvaluationDatapoint<D, T, O>[]> {
        const batchPromises = batch.map(async (datapoint) => {
            const output = await this.executor(datapoint.data);
            const target = datapoint.target;
    
            let scores: Record<string, number> = {};
            for (const evaluatorName of this.evaluatorNames) {
                const evaluator = this.evaluators[evaluatorName];
                const value = await evaluator(output, target);
    
                // If the evaluator returns a single number, use the evaluator name as the key
                if (isNumber(value)) {
                    if (isNaN(value)) {
                        throw new Error(`Evaluator ${evaluatorName} returned NaN`);
                    }
                    scores[evaluatorName] = value;
                } else {
                    // If the evaluator returns an object, merge its keys with the existing scores (flatten)
                    scores = { ...scores, ...value };
                }
            }
    
            return {
                executorOutput: output,
                data: datapoint.data,
                target,
                scores,
            } as EvaluationDatapoint<D, T, O>;
        });
    
        const results = await Promise.all(batchPromises);
    
        return results;
    }

    private getLength() {
        return this.data instanceof Dataset ? this.data.size() : this.data.length;
    }
}

export async function evaluate<D, T, O>({
    data, executor, evaluators, name, config
}: EvaluationConstructorProps<D, T, O>): Promise<void> {
    const evaluation = new Evaluation({ data, executor, evaluators, name, config });
    if (globalThis._set_global_evaluation) {
        globalThis._evaluation = evaluation;
    } else {
        await evaluation.run();
    }
}
