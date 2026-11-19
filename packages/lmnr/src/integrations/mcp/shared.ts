import { type ResolvedOptions } from "./options";
import { TurnTracker } from "./turns";

export type Handler = (request: any, extra: any) => unknown;

// The request-handler table of a low-level `Server` (1.x) / `Protocol` (2.x).
export interface ProtocolLike {
  _requestHandlers: Map<string, Handler>;
  getClientVersion?: () => unknown;
}

export interface ServerState {
  protocol: ProtocolLike;
  mcpServer?: any;
  options: ResolvedOptions;
  /** From this server's `initialize` result (1.x stores it nowhere else). */
  protocolVersion?: string;
  /** Whether a tool listed by this server declares its own `context`. */
  listedOwnContext: Map<string, boolean>;
}

const MAX_ENTRIES = 10_000;

// Process-wide, because Streamable HTTP servers usually create one server
// instance per session (or per request).
export const turnTracker = new TurnTracker();
// Tool name -> declares its own `context`, from every `tools/list` served in
// this process. Fallback for low-level servers (no tool registry to inspect).
export const listedOwnContextGlobal = new Map<string, boolean>();
export const warned = { ownContextTools: new Set<string>(), forcing: false };

/** Exported for tests. */
export const resetMcpState = () => {
  turnTracker.clear();
  listedOwnContextGlobal.clear();
  warned.ownContextTools.clear();
  warned.forcing = false;
};

export const boundedSet = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
};

export const isPlainObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Not `Object.hasOwn`: the repo's tsconfig lib predates es2022.
export const hasOwn = (value: object, key: string): boolean =>
  Object.getOwnPropertyDescriptor(value, key) !== undefined;

export const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
