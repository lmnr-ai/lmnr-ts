import zlib from "node:zlib";

import type { Definition as NockDefinition } from "nock";

/**
 * Decompresses a recording response based on its content-encoding header
 * Supports gzip and Brotli (br) compression formats
 */
export function decompressRecordingResponse(recording: NockDefinition): any {
  const contentEncoding = (recording as any)?.rawHeaders?.['content-encoding'];
  const isCompressed = contentEncoding === 'gzip' || contentEncoding === 'br';

  let response = recording.response;

  if (isCompressed && Array.isArray(response)) {
    const hexData = response[0];
    const buffer = Buffer.from(hexData, 'hex');

    if (contentEncoding === 'gzip') {
      response = JSON.parse(zlib.gunzipSync(buffer).toString());
    } else if (contentEncoding === 'br') {
      response = JSON.parse(zlib.brotliDecompressSync(buffer).toString());
    }
  } else if (isCompressed && typeof response === 'string') {
    const buffer = Buffer.from(response, 'hex');

    if (contentEncoding === 'gzip') {
      response = JSON.parse(zlib.gunzipSync(buffer).toString());
    } else if (contentEncoding === 'br') {
      response = JSON.parse(zlib.brotliDecompressSync(buffer).toString());
    }
  }

  return response;
}
