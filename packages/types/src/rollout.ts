export interface LanguageModelTextBlock {
  type: 'text';
  text: string;
}

export interface LanguageModelToolDefinitionOverride {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

/**
 * Event payload for rollout debugging sessions run events
 */
export interface RolloutRunEvent {
  event_type: 'run';
  data: {
    trace_id?: string;
    path_to_count?: Record<string, number>;
    args: Record<string, any> | any[];
    overrides?: Record<
      string,
      {
        system?: string | LanguageModelTextBlock[];
        tools?: LanguageModelToolDefinitionOverride[];
      }
    >;
  };
}

export interface RolloutHandshakeEvent {
  event_type: 'handshake';
  data: {
    session_id: string;
    project_id: string;
  };
}

/**
 * Parameter metadata for rollout functions
 */
export interface RolloutParam {
  name: string;
  type?: string;
  required?: boolean;
  nested?: RolloutParam[];
  default?: string;
}


export interface CachedSpan {
  name: string;
  input: string;  // JSON string
  output: string; // JSON string
  attributes: Record<string, any>; // Already parsed
}

export interface CacheMetadata {
  pathToCount: Record<string, number>;
  overrides?: Record<string, {
    system?: string | LanguageModelTextBlock[];
    tools?: LanguageModelToolDefinitionOverride[];
  }>;
}

export interface CacheServerResponse {
  pathToCount: CacheMetadata['pathToCount'];
  overrides?: CacheMetadata['overrides'];
  span?: CachedSpan;
}
