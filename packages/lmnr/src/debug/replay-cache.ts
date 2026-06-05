/**
 * In-process replay cache + the replay decision.
 *
 * Cache key is (spanPath, occurrenceIndex) (§6). Only the spine path is
 * populated, only for the first N occurrences. Replaces the old dev-server
 * `pathToCurrentIndex` + HTTP `POST /cached` machinery.
 */

import { CachedSpan } from "@lmnr-ai/types";

/** Holds cached spine responses, indexed by occurrence on the spine path. */
export class ReplayCache {
  private readonly _spinePath: string;
  private readonly _cacheUntil: number;
  private readonly _payloads: CachedSpan[];

  constructor(spinePath: string, cacheUntil: number, payloads: CachedSpan[]) {
    this._spinePath = spinePath;
    this._cacheUntil = cacheUntil;
    // spineCalls[:N] payloads, indexed by occurrence on the spine path.
    this._payloads = payloads.slice(0, cacheUntil);
  }

  get spinePath(): string {
    return this._spinePath;
  }

  get cacheUntil(): number {
    return this._cacheUntil;
  }

  /** Return the cached payload to replay, or undefined to run live (§8). */
  getCached(spanPath: string, occurrence: number): CachedSpan | undefined {
    if (spanPath !== this._spinePath) {
      return undefined;
    }
    if (occurrence >= this._cacheUntil) {
      return undefined;
    }
    if (occurrence >= this._payloads.length) {
      return undefined;
    }
    return this._payloads[occurrence];
  }
}
