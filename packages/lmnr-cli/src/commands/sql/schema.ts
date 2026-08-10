export const SQL_SCHEMA_HELP = `
Queries are scoped to your project automatically. There is no project_id
column — referencing it is rejected.

Available tables:
  spans
    span_id (UUID), trace_id (UUID), parent_span_id (UUID),
    name (String), path (String),
    span_type (String enum span_type), status (String enum status),
    start_time (DateTime64(9,'UTC')), end_time (DateTime64(9,'UTC')),
    duration (Decimal(18,9)),
    input (String), output (String),
    request_model (String), response_model (String), model (String),
    provider (String),
    input_tokens (Int64), output_tokens (Int64), total_tokens (Int64),
    input_cost (Float64), output_cost (Float64), total_cost (Float64),
    attributes (String), tags (Array(String)), tool_definitions (String),
    events (Array(Tuple(timestamp Int64, name String, attributes String)))

  traces
    id (UUID), trace_type (String enum trace_type), metadata (String),
    start_time (DateTime64(9,'UTC')), end_time (DateTime64(9,'UTC')),
    duration (Float64),
    input_tokens (Int64), output_tokens (Int64), total_tokens (Int64),
    cache_read_input_tokens (UInt64), cache_creation_input_tokens (UInt64),
    reasoning_tokens (UInt64),
    input_cost (Float64), output_cost (Float64), total_cost (Float64),
    status (String enum status), user_id (String), session_id (String),
    top_span_id (UUID), top_span_name (String),
    top_span_type (String enum span_type),
    tags (Array(String)), trace_tags (Array(String)),
    span_names (Array(String)), agent_input (String),
    has_browser_session (Bool)

  trace_outputs
    trace_id (UUID), start_time (DateTime64(9,'UTC')),
    agent_output (Array(String))

  evaluation_datapoints
    id (UUID), evaluation_id (UUID), trace_id (UUID),
    created_at (DateTime64(9,'UTC')), updated_at (DateTime64(9,'UTC')),
    data (String), target (String), metadata (String),
    executor_output (String), index (UInt64), group_id (String),
    scores (String), dataset_id (UUID), dataset_datapoint_id (UUID),
    dataset_datapoint_created_at (DateTime64(9,'UTC')),
    start_time (DateTime64(9,'UTC')), end_time (DateTime64(9,'UTC')),
    duration (Decimal(18,9)),
    input_cost (Float64), output_cost (Float64), total_cost (Float64),
    input_tokens (Int64), output_tokens (Int64), total_tokens (Int64),
    trace_status (LowCardinality(String) enum status),
    trace_metadata (String), trace_tags (Array(String)), top_span_id (UUID),
    trace_spans (Array(Tuple(name String, duration Float64, type String)))

  dataset_datapoints
    id (UUID), created_at (DateTime64(9,'UTC')), dataset_id (UUID),
    data (String), target (String), metadata (String)

  dataset_datapoint_versions
    id (UUID), created_at (DateTime64(9,'UTC')), dataset_id (UUID),
    data (String), target (String), metadata (String)

  logs
    log_id (UUID), time (DateTime64(9,'UTC')),
    observed_time (DateTime64(9,'UTC')),
    severity_number (UInt8), severity_text (String), body (String),
    attributes (String), trace_id (UUID), span_id (UUID),
    flags (UInt32), event_name (String)

  signal_events
    id (UUID), signal_id (UUID), trace_id (UUID), run_id (UUID),
    name (String), payload (String), timestamp (DateTime64(9,'UTC')),
    severity (UInt8: 0=INFO|1=WARNING|2=CRITICAL), summary (String),
    clusters (Array(UUID))

  clusters
    id (UUID), signal_id (UUID), name (String),
    level (UInt8), parent_id (UUID),
    num_signal_events (UInt32), num_children_clusters (UInt16),
    created_at (DateTime64(9,'UTC')), updated_at (DateTime64(9,'UTC'))

  signal_runs
    signal_id (UUID), job_id (UUID), trigger_id (UUID), run_id (UUID),
    trace_id (UUID), status (String enum signal_run_status),
    mode (String enum signal_run_mode), event_id (UUID),
    error_message (String), updated_at (DateTime64(9,'UTC')),
    input_tokens (UInt32), cache_read_tokens (UInt32),
    output_tokens (UInt32)

  labeling_queue_items
    id (UUID), queue_id (UUID), payload (String), metadata (String),
    status (UInt8: 0=unlabeled|1=approved), edit (String),
    created_at (DateTime64(3,'UTC')), updated_at (DateTime64(3,'UTC'))

Enums:
  span_type: 'DEFAULT', 'LLM', 'EXECUTOR', 'EVALUATOR', 'EVALUATION', 'TOOL',
             'HUMAN_EVALUATOR', 'CACHED', 'UNKNOWN'
  trace_type: 'DEFAULT', 'EVALUATION', 'PLAYGROUND'
  status: 'success', 'error'
  signal_run_status: 'PENDING', 'COMPLETED', 'FAILED', 'UNKNOWN'
  signal_run_mode: 'BATCH', 'REALTIME', 'UNKNOWN'

Joins:
  spans.trace_id = traces.id
  signal_events.trace_id = traces.id
  trace_outputs.trace_id = traces.id
  has(signal_events.clusters, clusters.id)
  clusters.parent_id = toUUID('00000000-0000-0000-0000-000000000000') for
    top-level clusters (nil UUID, not SQL NULL)
`;
