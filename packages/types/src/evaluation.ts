import { StringUUID } from "./utils";

export type InitEvaluationResponse = {
  id: StringUUID;
  createdAt: Date;
  groupId: string;
  name: string;
  projectId: StringUUID;
};

export type Dataset = {
  id: StringUUID;
  name: string;
  createdAt: string;
};

export type PushDatapointsResponse = {
  datasetId: StringUUID;
};

export type EvaluationDatapointDatasetLink = {
  datasetId: StringUUID;
  datapointId: StringUUID;
  createdAt: string;
};

export type EvaluationDatapoint<D, T, O> = {
  id: StringUUID;
  data: D;
  target?: T;
  metadata?: Record<string, any>;
  executorOutput?: O;
  scores?: Record<string, number | null>;
  traceId: string;
  index: number;
  executorSpanId?: string;
  datasetLink?: EvaluationDatapointDatasetLink;
};

// Forward declare Datapoint type (will be defined in evaluations module)
export interface Datapoint<D = any, T = any> {
  data: D;
  target?: T;
  metadata?: Record<string, any>;
}

export type GetDatapointsResponse<D, T> = {
  items: Datapoint<D, T>[];
  totalCount: number;
  anyInProject: boolean;
};

export type SemanticSearchResult = {
  datasetId: StringUUID;
  data: Record<string, any>;
  content: string;
  score: number;
};

export type SemanticSearchResponse = {
  results: SemanticSearchResult[];
};
