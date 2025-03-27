import { AgentResource } from "./resources/agent";
import { BrowserEventsResource } from "./resources/browser-events";
import { EvalsResource } from "./resources/evals";
import { PipelineResource } from "./resources/pipeline";
import { SemanticSearchResource } from "./resources/semantic-search";

export class LaminarClient {
  private baseUrl: string;
  private projectApiKey: string;
  private _agent: AgentResource;
  private _browserEvents: BrowserEventsResource;
  private _evals: EvalsResource;
  private _pipelines: PipelineResource;
  private _semanticSearch: SemanticSearchResource;

  constructor({
    baseUrl,
    projectApiKey,
    port,
  }: {
    baseUrl?: string,
    projectApiKey?: string,
    port?: number,
  }) {
    this.projectApiKey = projectApiKey ?? process.env.LMNR_PROJECT_API_KEY!;
    const httpPort = port ?? (
      baseUrl?.match(/:\d{1,5}$/g)
        ? parseInt(baseUrl.match(/:\d{1,5}$/g)![0].slice(1))
        : 443);
    this.baseUrl = `${baseUrl?.replace(/\/$/, '').replace(/:\d{1,5}$/g, '') ?? 'https://api.lmnr.ai'}:${httpPort}`;
    this._agent = new AgentResource(this.baseUrl, this.projectApiKey);
    this._browserEvents = new BrowserEventsResource(this.baseUrl, this.projectApiKey);
    this._evals = new EvalsResource(this.baseUrl, this.projectApiKey);
    this._pipelines = new PipelineResource(this.baseUrl, this.projectApiKey);
    this._semanticSearch = new SemanticSearchResource(this.baseUrl, this.projectApiKey);
  }

  public get agent() {
    return this._agent;
  }

  public get browserEvents() {
    return this._browserEvents;
  }

  public get evals() {
    return this._evals;
  }

  public get pipelines() {
    return this._pipelines;
  }

  public get semanticSearch() {
    return this._semanticSearch;
  }
}
