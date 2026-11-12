import { initializeLogger } from "../../utils";

const logger = initializeLogger();

/**
 * Options for the LangChain instrumentation.
 */
export interface LangchainInstrumentOptions {
  /**
   * Record LangChain run metadata as the `langchain.metadata` span attribute.
   * Defaults to `false`. Env: `LMNR_LANGCHAIN_RECORD_METADATA`.
   */
  recordMetadata?: boolean;
}

/**
 * Options for the LangGraph instrumentation.
 */
export interface LanggraphInstrumentOptions {
  /**
   * Record the graph's nodes and edges on the graph's root span, which
   * powers the graph view in Laminar. Defaults to `true`.
   * Env: `LMNR_LANGGRAPH_RECORD_GRAPH`.
   */
  recordGraph?: boolean;
}

/**
 * Options for the Temporal instrumentation. These take precedence over the
 * same options passed in `instrumentModules.temporal` or to
 * `LaminarTemporalInterceptors.ActivityInterceptorFactory`.
 */
export interface TemporalInstrumentOptions {
  /**
   * Wrap each activity execution in a span named after the activity type.
   * When `false`, the propagated trace context is still activated, so spans
   * created inside the activity nest under the workflow. Defaults to `true`.
   * Env: `LMNR_TEMPORAL_CREATE_ACTIVITY_SPAN`.
   */
  createActivitySpan?: boolean;
  /**
   * Record the activity's arguments as the activity span input. Defaults to
   * `true`. Env: `LMNR_TEMPORAL_RECORD_ACTIVITY_ARGS`.
   */
  recordActivityArgs?: boolean;
  /**
   * Record the activity's return value as the activity span output. Defaults
   * to `true`. Env: `LMNR_TEMPORAL_RECORD_ACTIVITY_OUTPUT`.
   */
  recordActivityOutput?: boolean;
}

/**
 * Per-instrumentation options, keyed by instrumentation name. Each option
 * can also be set with an `LMNR_{INSTRUMENT}_{OPTION}` environment variable
 * (e.g. `LMNR_LANGGRAPH_RECORD_GRAPH=false`); a value passed to
 * `Laminar.initialize` wins over the environment.
 */
export interface InstrumentOptions {
  langchain?: LangchainInstrumentOptions;
  langgraph?: LanggraphInstrumentOptions;
  temporal?: TemporalInstrumentOptions;
}

type Instrument = keyof InstrumentOptions;
type OptionOf<I extends Instrument> = keyof NonNullable<InstrumentOptions[I]>;

// The single declaration of every option and its default. Environment
// variable names are derived from it, so a new option needs no other wiring.
const DEFAULTS = {
  langchain: { recordMetadata: false },
  langgraph: { recordGraph: true },
  temporal: {
    createActivitySpan: true,
    recordActivityArgs: true,
    recordActivityOutput: true,
  },
} satisfies {
  [I in Instrument]-?: Required<NonNullable<InstrumentOptions[I]>>;
};

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/** `("langgraph", "recordGraph")` -> `LMNR_LANGGRAPH_RECORD_GRAPH` */
export const instrumentOptionEnvVar = (
  instrument: string,
  option: string,
): string =>
  `LMNR_${instrument}_${option.replace(/([A-Z])/g, "_$1")}`.toUpperCase();

const has = (obj: object, key: string): boolean =>
  Object.getOwnPropertyDescriptor(obj, key) !== undefined;

/**
 * Merge the environment and the options passed to `Laminar.initialize` into
 * the values that were set explicitly. Defaults are not filled in, so the
 * Temporal instrumentation can tell an unset option from a default and fall
 * back to its legacy options. Invalid input is logged and ignored, never
 * thrown.
 */
export const resolveInstrumentOptions = (
  options?: InstrumentOptions,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (message) => logger.warn(message),
): InstrumentOptions => {
  const resolved: Record<string, Record<string, boolean>> = {};
  const set = (instrument: string, option: string, value: boolean) => {
    resolved[instrument] = { ...resolved[instrument], [option]: value };
  };

  for (const [instrument, declared] of Object.entries(DEFAULTS)) {
    for (const option of Object.keys(declared)) {
      const name = instrumentOptionEnvVar(instrument, option);
      const raw = env[name]?.trim().toLowerCase();
      if (!raw) continue;
      if (TRUE_VALUES.has(raw)) {
        set(instrument, option, true);
      } else if (FALSE_VALUES.has(raw)) {
        set(instrument, option, false);
      } else {
        warn(
          `[Laminar] Ignoring ${name}=${env[name]}: expected true or false.`,
        );
      }
    }
  }

  for (const [instrument, given] of Object.entries(options ?? {})) {
    if (!has(DEFAULTS, instrument)) {
      warn(`[Laminar] Ignoring instrumentOptions.${instrument}: unknown.`);
      continue;
    }
    if (given === undefined || given === null) continue;
    if (typeof given !== "object") {
      warn(
        `[Laminar] Ignoring instrumentOptions.${instrument}: expected an object.`,
      );
      continue;
    }
    const known = DEFAULTS[instrument as Instrument];
    for (const [option, value] of Object.entries(given)) {
      if (!has(known, option)) {
        warn(
          `[Laminar] Ignoring instrumentOptions.${instrument}.${option}: unknown.`,
        );
        continue;
      }
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        warn(
          `[Laminar] Ignoring instrumentOptions.${instrument}.${option}: ` +
            "expected a boolean.",
        );
        continue;
      }
      set(instrument, option, value);
    }
  }

  return resolved as InstrumentOptions;
};

// Resolved by `Laminar.initialize`, cleared by `Laminar.shutdown`. When unset
// (instrumentations registered without `Laminar.initialize`), the first read
// resolves it from the environment.
let _resolved: InstrumentOptions | undefined;

export const setInstrumentOptions = (options?: InstrumentOptions): void => {
  _resolved = resolveInstrumentOptions(options);
};

export const resetInstrumentOptions = (): void => {
  _resolved = undefined;
};

/**
 * The value set by `Laminar.initialize` or the environment, or `undefined`.
 * Read it when a span is recorded, not when an instrumentation is built:
 * instrumentations are patched once per process and outlive a
 * `shutdown()` / `initialize()` cycle.
 */
export const getExplicitInstrumentOption = <
  I extends Instrument,
  O extends OptionOf<I>,
>(
  instrument: I,
  option: O,
): boolean | undefined => {
  _resolved ??= resolveInstrumentOptions();
  const options = _resolved[instrument] as Record<O, boolean> | undefined;
  return options?.[option];
};

/** The option's value, falling back to its default. */
export const getInstrumentOption = <
  I extends Instrument,
  O extends OptionOf<I>,
>(
  instrument: I,
  option: O,
): boolean =>
  getExplicitInstrumentOption(instrument, option) ??
  (DEFAULTS[instrument] as Record<O, boolean>)[option];
