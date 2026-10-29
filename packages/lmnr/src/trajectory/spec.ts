/**
 * Constants of lmnr-atif, Laminar's extension to ATIF.
 *
 * The spec itself, its JSON schema and its fixtures live in `spec/lmnr-atif/`
 * at the repository root, copied verbatim from the Python SDK.
 * `test/trajectory-spec.test.ts` checks that `SPEC_VERSION` matches all of
 * them.
 */

// Version of `spec/lmnr-atif/lmnr-atif.md` this package implements.
export const SPEC_VERSION = "0.1.0";

// Every Laminar field lives under `extra[NAMESPACE]`.
export const NAMESPACE = "lmnr";

// ATIF version writers emit, and the oldest one the extension can live in
// (`tool_call.extra`, `observation_result.extra` and `llm_call_count` are v1.7).
export const ATIF_SCHEMA_VERSION = "ATIF-v1.8";
export const MIN_ATIF_VERSION: [number, number] = [1, 7];

export type DefKind = "system_prompts" | "tool_definitions" | "input_messages";
