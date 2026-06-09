import { BrowserEventsResource } from "./resources/browser-events";
import { CliResource } from "./resources/cli";
import { DatasetsResource } from "./resources/datasets";
import { EvalsResource } from "./resources/evals";
import { EvaluatorsResource } from "./resources/evaluators";
import { RolloutSessionsResource } from "./resources/rollout-sessions";
import { SqlResource } from "./resources/sql";
import { TagsResource } from "./resources/tags";
import { TracesResource } from "./resources/traces";
import { loadEnv } from "./utils";

export class LaminarClient {
  private baseUrl: string;
  private projectApiKey: string;
  private _browserEvents: BrowserEventsResource;
  private _cli: CliResource;
  private _datasets: DatasetsResource;
  private _evals: EvalsResource;
  private _evaluators: EvaluatorsResource;
  private _rolloutSessions: RolloutSessionsResource;
  private _sql: SqlResource;
  private _tags: TagsResource;
  private _traces: TracesResource;

  constructor({
    baseUrl,
    projectApiKey,
    port,
    cliUserProjectId,
  }: {
    baseUrl?: string,
    projectApiKey?: string,
    port?: number,
    /**
     * CLI user-token auth: when set, `projectApiKey` is a BetterAuth user
     * access JWT and the CLI-surfaced resources (sql/datasets/rollouts) route
     * to `/v1/cli/*` with this project id in the `x-lmnr-project-id` header.
     */
    cliUserProjectId?: string,
  } = {}) {
    loadEnv();
    this.projectApiKey = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY!;
    const httpPort = port ?? (
      baseUrl?.match(/:\d{1,5}$/g)
        ? parseInt(baseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const baseUrlNoPort = (baseUrl ?? process.env.LMNR_BASE_URL)
      ?.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    this.baseUrl = `${baseUrlNoPort ?? 'https://api.lmnr.ai'}:${httpPort}`;
    // Only the CLI-twinned resources accept cliUserProjectId; the rest are
    // always project-key / `/v1` (the CLI never calls them on the user path).
    this._browserEvents = new BrowserEventsResource(this.baseUrl, this.projectApiKey);
    this._cli = new CliResource(this.baseUrl, this.projectApiKey);
    this._datasets = new DatasetsResource(this.baseUrl, this.projectApiKey, cliUserProjectId);
    this._evals = new EvalsResource(this.baseUrl, this.projectApiKey);
    this._evaluators = new EvaluatorsResource(this.baseUrl, this.projectApiKey);
    this._rolloutSessions = new RolloutSessionsResource(this.baseUrl, this.projectApiKey, cliUserProjectId);
    this._sql = new SqlResource(this.baseUrl, this.projectApiKey, cliUserProjectId);
    this._tags = new TagsResource(this.baseUrl, this.projectApiKey);
    this._traces = new TracesResource(this.baseUrl, this.projectApiKey);
  }

  public get browserEvents() {
    return this._browserEvents;
  }

  public get cli() {
    return this._cli;
  }

  public get datasets() {
    return this._datasets;
  }

  public get evals() {
    return this._evals;
  }

  public get evaluators() {
    return this._evaluators;
  }

  public get rolloutSessions() {
    return this._rolloutSessions;
  }

  public get sql() {
    return this._sql;
  }

  public get tags() {
    return this._tags;
  }

  public get traces() {
    return this._traces;
  }
}

export {
  type CacheOutcome,
  RolloutSessionsResource,
} from "./resources/rollout-sessions";
