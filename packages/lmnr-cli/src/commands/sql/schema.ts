export const SQL_SCHEMA_HELP = `
Available tables:
  spans
    span_id (UUID), name (String), span_type (String: DEFAULT|LLM|TOOL),
    start_time (DateTime64), end_time (DateTime64), duration (Float64),
    input_cost (Float64), output_cost (Float64), total_cost (Float64),
    input_tokens (Int64), output_tokens (Int64), total_tokens (Int64),
    request_model (String), response_model (String), model (String),
    trace_id (UUID), provider (String), path (String),
    input (String), output (String), status (String),
    parent_span_id (UUID), attributes (String), tags (Array(String))

  traces
    id (UUID), start_time (DateTime64), end_time (DateTime64),
    input_tokens (Int64), output_tokens (Int64), total_tokens (Int64),
    input_cost (Float64), output_cost (Float64), total_cost (Float64),
    duration (Float64), metadata (String), session_id (String),
    user_id (String), status (String), top_span_id (UUID),
    top_span_name (String), top_span_type (String), trace_type (String),
    tags (Array(String)), has_browser_session (Bool)

  events
    id (UUID), type (String), name (String), span_id (UUID),
    timestamp (DateTime64), attributes (String)

  signal_events
    id (UUID), signal_id (UUID), trace_id (UUID), run_id (UUID),
    name (String), payload (String), timestamp (DateTime64)

  signal_runs
    signal_id (UUID), job_id (UUID), trigger_id (UUID), run_id (UUID),
    trace_id (UUID), status (String), event_id (UUID), updated_at (DateTime64)

  evaluation_datapoints
    id (UUID), evaluation_id (UUID), data (String), target (String),
    metadata (String), executor_output (String), index (UInt64),
    trace_id (UUID), group_id (String), scores (String),
    created_at (DateTime64), dataset_id (UUID),
    dataset_datapoint_id (UUID), dataset_datapoint_created_at (DateTime64)

  dataset_datapoints
    id (UUID), created_at (DateTime64), dataset_id (UUID),
    data (String), target (String), metadata (String)
`;
