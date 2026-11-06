import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../../utils";
import { type InitializeOptions } from "../interfaces";
import { LangfuseBridge } from "./langfuse";
import {
  type Bridge,
  type BridgeContext,
  type InstrumentationKey,
  type LaminarBridge,
} from "./types";

export {
  type Bridge,
  type BridgeContext,
  type InstrumentationKey,
  type LaminarBridge,
  LLM_INSTRUMENTATIONS,
} from "./types";

const logger = initializeLogger();

const BRIDGES = new Map<string, () => Bridge>([
  ["langfuse", () => new LangfuseBridge()],
] satisfies [LaminarBridge, () => Bridge][]);

/**
 * The requested bridges that are known and whose SDK is installed in a
 * supported version, deduplicated. Unknown or unavailable ones are logged and
 * dropped.
 */
export const resolveBridges = (
  names: readonly string[] | undefined,
): Bridge[] => {
  const bridges: Bridge[] = [];
  for (const name of new Set(names ?? [])) {
    const factory = BRIDGES.get(name);
    if (!factory) {
      logger.warn(
        `Unknown Laminar bridge "${name}". ` +
          `Supported: ${[...BRIDGES.keys()].join(", ")}.`,
      );
      continue;
    }
    const bridge = factory();
    let available = false;
    try {
      available = bridge.isAvailable();
    } catch (e) {
      logger.warn(`Laminar ${name} bridge is unavailable: ${errorMessage(e)}`);
    }
    if (available) bridges.push(bridge);
  }
  return bridges;
};

/** Union of the bridges' conflicting instrumentations. */
export const conflictingInstrumentations = (
  bridges: readonly Bridge[],
): InstrumentationKey[] =>
  Array.from(new Set(bridges.flatMap((b) => b.conflictingInstrumentations)));

/**
 * The user passed `instrumentModules` explicitly: honor it, but warn about
 * modules whose spans the bridges also carry.
 */
export const warnAboutOverlaps = (
  bridges: readonly Bridge[],
  instrumentModules: InitializeOptions["instrumentModules"],
): void => {
  for (const bridge of bridges) {
    const overlap = bridge.conflictingInstrumentations.filter(
      (key) => instrumentModules?.[key],
    );
    if (overlap.length > 0) {
      logger.warn(
        `The Laminar ${bridge.name} bridge is enabled and instrumentModules ` +
          `also instruments ${overlap.join(", ")}. Calls traced by both ` +
          `${bridge.name} and Laminar will show up twice.`,
      );
    }
  }
};

export const installBridges = (
  bridges: readonly Bridge[],
  ctx: BridgeContext,
): Bridge[] => {
  const installed: Bridge[] = [];
  for (const bridge of bridges) {
    try {
      bridge.install(ctx);
      installed.push(bridge);
    } catch (e) {
      logger.warn(
        `Failed to install the Laminar ${bridge.name} bridge: ${errorMessage(e)}`,
      );
    }
  }
  return installed;
};

export const uninstallBridges = (bridges: readonly Bridge[]): void => {
  for (const bridge of bridges) {
    try {
      bridge.uninstall();
    } catch (e) {
      logger.debug(
        `Failed to uninstall the Laminar ${bridge.name} bridge: ${errorMessage(e)}`,
      );
    }
  }
};

export const flushBridges = (bridges: readonly Bridge[]): void => {
  for (const bridge of bridges) {
    try {
      bridge.onFlush?.();
    } catch (e) {
      logger.debug(
        `Laminar ${bridge.name} bridge flush hook failed: ${errorMessage(e)}`,
      );
    }
  }
};
