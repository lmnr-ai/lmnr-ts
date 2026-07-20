import { BrowserEventsResource } from "./resources/browser-events";
import { CliResource } from "./resources/cli";
import { DatasetsResource } from "./resources/datasets";
import { EvalsResource } from "./resources/evals";
import { EvaluatorsResource } from "./resources/evaluators";
import { type LaminarAuth } from "./resources/index";
import { RolloutSessionsResource } from "./resources/rollout-sessions";
import { SqlResource } from "./resources/sql";
import { TagsResource } from "./resources/tags";
import { TracesResource } from "./resources/traces";
import { loadEnv } from "./utils";

export class LaminarClient {
  private baseUrl: string;
  private auth: LaminarAuth;
  private configuredUrl?: string;
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
    port,
    auth,
    projectApiKey,
    cliUserProjectId,
  }: {
    baseUrl?: string,
    port?: number,
    /**
     * Unified auth. A discriminated union that drives both the URL prefix and
     * the request headers:
     *  - `{ type: "apiKey", key }`               → project key, `/v1/*`.
     *  - `{ type: "userToken", token, projectId }` → user JWT, `/v1/cli/*` with
     *    `x-lmnr-project-id`.
     * When omitted, the legacy `projectApiKey` / `cliUserProjectId` fields (or
     * `LMNR_PROJECT_API_KEY`) are normalized into this union.
     */
    auth?: LaminarAuth,
    /**
     * @deprecated Pass `auth: { type: "apiKey", key }` instead. Kept for
     * backward compatibility — normalized into the unified `auth` union.
     */
    projectApiKey?: string,
    /**
     * @deprecated Pass `auth: { type: "userToken", token, projectId }` instead.
     * Kept for backward compatibility: when set, the legacy `projectApiKey` is
     * treated as a user JWT and routes to `/v1/cli/*` with this project id.
     */
    cliUserProjectId?: string,
  } = {}) {
    loadEnv();
    this.auth = LaminarClient.normalizeAuth(auth, projectApiKey, cliUserProjectId);
    const resolvedBaseUrl = baseUrl ?? process.env.LMNR_BASE_URL;
    this.configuredUrl = resolvedBaseUrl;
    const httpPort = port ?? (
      resolvedBaseUrl?.match(/:\d{1,5}$/g)
        ? parseInt(resolvedBaseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const baseUrlNoPort = resolvedBaseUrl
      ?.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    this.baseUrl = `${baseUrlNoPort ?? 'https://api.lmnr.ai'}:${httpPort}`;
    this._browserEvents = new BrowserEventsResource(this.baseUrl, this.auth);
    this._cli = new CliResource(this.baseUrl, this.auth);
    this._datasets = new DatasetsResource(this.baseUrl, this.auth);
    this._evals = new EvalsResource(this.baseUrl, this.auth);
    this._evaluators = new EvaluatorsResource(this.baseUrl, this.auth);
    this._rolloutSessions = new RolloutSessionsResource(this.baseUrl, this.auth);
    this._sql = new SqlResource(this.baseUrl, this.auth);
    this._tags = new TagsResource(this.baseUrl, this.auth);
    this._traces = new TracesResource(this.baseUrl, this.auth);
  }

  /**
   * Normalize the constructor's auth inputs into a {@link LaminarAuth} union.
   * Precedence: an explicit `auth` wins; otherwise the legacy
   * `projectApiKey` (+ optional `cliUserProjectId`) is mapped — a present
   * `cliUserProjectId` selects the user-token surface, otherwise the project
   * key surface. Falls back to `LMNR_PROJECT_API_KEY` as a project key.
   */
  private static normalizeAuth(
    auth: LaminarAuth | undefined,
    projectApiKey: string | undefined,
    cliUserProjectId: string | undefined,
  ): LaminarAuth {
    if (auth) {
      return auth;
    }
    const key = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY!;
    if (cliUserProjectId) {
      return { type: "userToken", token: key, projectId: cliUserProjectId };
    }
    return { type: "apiKey", key };
  }

  /**
   * The base URL this client was configured with (constructor arg or
   * `LMNR_BASE_URL`), before port normalization; `undefined` when the client
   * fell back to the default Laminar Cloud URL. Lets integrations that accept
   * a pre-constructed client derive companion transports (e.g. a span
   * exporter) from the same connection settings.
   */
  public get configuredBaseUrl(): string | undefined {
    return this.configuredUrl;
  }

  /**
   * The project API key this client authenticates with, or `undefined` when
   * it uses user-token auth.
   */
  public get apiKey(): string | undefined {
    return this.auth.type === "apiKey" ? this.auth.key : undefined;
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

export type { CliProject, ProjectKeyProbe } from "./resources/cli";
export type { LaminarAuth } from "./resources/index";
export {
  type CacheOutcome,
  RolloutSessionsResource,
} from "./resources/rollout-sessions";
