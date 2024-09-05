import { Laminar } from "./laminar";
import { CreateEvaluationResponse, EvaluationDatapoint } from "./types";

const DEFAULT_BATCH_SIZE = 5;

/**
 * Configuration for the Evaluator
 */
interface EvaluatorConfig {
    batchSize?: number;
    projectApiKey?: string;
    baseUrl?: string;
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
type EvaluatorFunction<O, T> = (output: O | Promise<O>, target: T, ...args: any[]) => EvaluatorFunctionReturn | Promise<EvaluatorFunctionReturn>;

interface EvaluatorConstructorProps<D, T, O> {
    /**
     * List of data points to evaluate. `data` is the input to the executor function, `target` is the input to the evaluator function.
     */
    data: (Datapoint<D, T>[]) | Dataset<D, T>;
    /**
     * The executor function. Takes the data point + any additional arguments and returns the output to evaluate.
     */
    executor: (data: D, ...args: any[]) => O;
    /**
     * List of evaluator functions. Each evaluator function takes the output of the executor _and_ the target data, and returns
     * a score. The score can be a single number or a record of string keys and number values.
     * If the score is a single number, it will be named after the evaluator function. If the function is anonymous, it will be named
     * `evaluator_${index}`, where index is the index of the evaluator function in the list starting from 1.
     */
    evaluators: EvaluatorFunction<O, T>[];
    /**
     * Optional override configurations for the evaluator.
     */
    config?: EvaluatorConfig;
}

export class Evaluation<D, T, O> {
    private name: string;
    private data: Datapoint<D, T>[] | Dataset<D, T>;
    private executor: (data: D, ...args: any[]) => O;
    private evaluators: Record<string, EvaluatorFunction<O, T>>;
    private evaluatorNames: string[];
    private batchSize: number = DEFAULT_BATCH_SIZE;

    /**
     * Create a new evaluation and prepare data.
     * @param name Name of the evaluation.
     * @param props.data List of data points to evaluate. `data` is the input to the executor function, `target` is the input to the evaluator function.
     * @param props.executor The executor function. Takes the data point + any additional arguments and returns the output to evaluate.
     * @param props.evaluators List of evaluator functions. Each evaluator function takes the output of the executor and the target data, and returns.
     */
    constructor(name: string, {
        data, executor, evaluators, config
    }: EvaluatorConstructorProps<D, T, O>) {
        this.name = name;
        this.data = data;
        this.executor = executor;
        this.evaluators = Object.fromEntries(evaluators.map((e, i) => [e.name.length > 0 ? e.name : `evaluator_${i + 1}`, e]));
        this.evaluatorNames = evaluators.map((e, i) => e.name.length > 0 ? e.name : `evaluator_${i + 1}`);
        if (config) {
            this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
        }
        Laminar.initialize({ projectApiKey: config?.projectApiKey, baseUrl: config?.baseUrl });
    }

    /** 
     * Runs the evaluation.
     *
     * Creates a new evaluation if no evaluation with such name exists, or adds data to an existing one otherwise.
     * Evaluates data points in batches of `batchSize`. The executor function is called on each data point
     * to get the output, and then evaluate it by each evaluator function.
     */
    public async run(): Promise<void> {
        const response = await Laminar.createEvaluation(this.name) as CreateEvaluationResponse;
        const batchPromises = [];
        const length = this.data instanceof Dataset ? this.data.size() : this.data.length;
        for (let i = 0; i < length; i += this.batchSize) {
            const batch = this.data.slice(i, i + this.batchSize);
            batchPromises.push(this.evaluateBatch(batch));
        }

        try {
            await Promise.all(batchPromises);
            await Laminar.updateEvaluationStatus(response.name, 'Finished');
            console.log(`Evaluation ${response.id} complete`);

        } catch (e) {
            console.error(`Error evaluating batch: ${e}`);
        }
    }

    private async evaluateBatch(batch: Datapoint<D, T>[]): Promise<void> {
        let results = [];
        for (const datapoint of batch) {
            const output = await this.executor(datapoint.data);
            const target = datapoint.target;

            // iterate in order of evaluators
            let scores: Record<string, EvaluatorFunctionReturn> = {};
            for (const evaluatorName of this.evaluatorNames) {
                const evaluator = this.evaluators[evaluatorName];
                const value = await evaluator(output, target);
                // if the evaluator returns a single number, use the evaluator name as the key
                if (typeof value === 'number') {
                    scores[evaluatorName] = value;
                } else {
                    // if the evaluator returns an object, use the object keys as the keys
                    scores = { ...scores, ...value };
                }
            };

            results.push({
                executorOutput: output,
                data: datapoint.data,
                target,
                scores,
            } as EvaluationDatapoint<D, T, O>);
        };

        return Laminar.postEvaluationResults(this.name, results);
    }
}
