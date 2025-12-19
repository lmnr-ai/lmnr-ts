import { config } from "dotenv";

import { AgentResource } from "./resources/agent";
import { BrowserEventsResource } from "./resources/browser-events";
import { DatasetsResource } from "./resources/datasets";
import { EvalsResource } from "./resources/evals";
import { EvaluatorsResource } from "./resources/evaluators";
import { RolloutSessionsResource } from "./resources/rollout-sessions";
import { TagsResource } from "./resources/tags";

export class LaminarClient {
  private baseUrl: string;
  private projectApiKey: string;
  private _agent: AgentResource;
  private _browserEvents: BrowserEventsResource;
  private _datasets: DatasetsResource;
  private _evals: EvalsResource;
  private _evaluators: EvaluatorsResource;
  private _rolloutSessions: RolloutSessionsResource;
  private _tags: TagsResource;

  constructor({
    baseUrl,
    projectApiKey,
    port,
  }: {
    baseUrl?: string,
    projectApiKey?: string,
    port?: number,
  } = {}) {
    config({
      quiet: true,
    });
    this.projectApiKey = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY!;
    const httpPort = port ?? (
      baseUrl?.match(/:\d{1,5}$/g)
        ? parseInt(baseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    const baseUrlNoPort = (baseUrl ?? process.env.LMNR_BASE_URL)
      ?.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');
    this.baseUrl = `${baseUrlNoPort ?? 'https://api.lmnr.ai'}:${httpPort}`;
    this._agent = new AgentResource(this.baseUrl, this.projectApiKey);
    this._browserEvents = new BrowserEventsResource(this.baseUrl, this.projectApiKey);
    this._datasets = new DatasetsResource(this.baseUrl, this.projectApiKey);
    this._evals = new EvalsResource(this.baseUrl, this.projectApiKey);
    this._evaluators = new EvaluatorsResource(this.baseUrl, this.projectApiKey);
    this._rolloutSessions = new RolloutSessionsResource(this.baseUrl, this.projectApiKey);
    this._tags = new TagsResource(this.baseUrl, this.projectApiKey);
  }

  public get agent() {
    return this._agent;
  }

  public get browserEvents() {
    return this._browserEvents;
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

  public get tags() {
    return this._tags;
  }
}
