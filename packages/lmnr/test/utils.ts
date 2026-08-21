import zlib from "node:zlib";

import type { Definition as NockDefinition } from "nock";

/** A cassette entry as written by `nock.recorder`, with the headers it saw. */
type Recording = NockDefinition & { rawHeaders?: unknown };

/** `rawHeaders` is an object in our cassettes, but nock also emits the flat
 * `[name, value, name, value, ...]` array form — handle both. */
type RecordingHeaders = Record<string, string | string[]> | string[];

const isCompressed = (contentEncoding: unknown): contentEncoding is string =>
  contentEncoding === "gzip" || contentEncoding === "br";

const decompress = (hexData: string, contentEncoding: string): any => {
  const buffer = Buffer.from(hexData, "hex");
  const decoded =
    contentEncoding === "gzip"
      ? zlib.gunzipSync(buffer)
      : zlib.brotliDecompressSync(buffer);
  return JSON.parse(decoded.toString());
};

const readContentEncoding = (recording: Recording): unknown => {
  const headers = recording.rawHeaders as RecordingHeaders | undefined;
  if (!headers) {
    return undefined;
  }
  if (Array.isArray(headers)) {
    const index = headers.findIndex(
      (entry) => String(entry).toLowerCase() === "content-encoding",
    );
    return index === -1 ? undefined : headers[index + 1];
  }
  return headers["content-encoding"];
};

/**
 * Decompresses a recording response based on its content-encoding header
 * Supports gzip and Brotli (br) compression formats
 */
export function decompressRecordingResponse(recording: Recording): any {
  const contentEncoding = readContentEncoding(recording);
  const response = recording.response;

  if (!isCompressed(contentEncoding)) {
    return response;
  }

  if (Array.isArray(response)) {
    return decompress(response[0] as string, contentEncoding);
  }
  if (typeof response === "string") {
    return decompress(response, contentEncoding);
  }

  return response;
}

/**
 * The recorded headers to replay alongside {@link decompressRecordingResponse},
 * with `content-encoding` dropped whenever the body was decompressed.
 *
 * Cassettes store the body exactly as the wire delivered it — hex, still
 * compressed — so once we decode it the recorded `content-encoding` no longer
 * describes what we hand to `.reply()`. Replaying it anyway makes nock take its
 * `isContentEncoded` branch, which assumes an encoded body is an array of hex
 * chunks and runs `Buffer.from(body, "hex")` over it. Against a decoded object
 * that throws `ERR_INVALID_ARG_TYPE` inside nock's playback, which surfaces as
 * a failed request AND leaves the runner hanging on an unresolved promise
 * rather than as a clean assertion failure.
 */
export function recordingReplyHeaders(
  recording: Recording,
): RecordingHeaders | undefined {
  const headers = recording.rawHeaders as RecordingHeaders | undefined;
  if (!headers || !isCompressed(readContentEncoding(recording))) {
    return headers;
  }

  if (Array.isArray(headers)) {
    const stripped: string[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() !== "content-encoding") {
        stripped.push(headers[i], headers[i + 1]);
      }
    }
    return stripped;
  }

  const { "content-encoding": _dropped, ...rest } = headers;
  return rest;
}
