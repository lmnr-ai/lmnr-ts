// This class could be just an initialization of the OTLP exporter,
// but OTel v2 has some breaking changes, so we're applying
// a small backward-compatibility fix here.

import { Metadata } from "@grpc/grpc-js";
import { ExportResult } from "@opentelemetry/core";
import {
  OTLPTraceExporter as ExporterGrpc,
} from "@opentelemetry/exporter-trace-otlp-grpc";
import {
  OTLPTraceExporter as ExporterHttp,
} from "@opentelemetry/exporter-trace-otlp-proto";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { getOtelEnvVar, initializeLogger, parseOtelHeaders } from "../../utils";
import { makeSpanOtelV2Compatible } from "./compat";

const logger = initializeLogger();

export class LaminarSpanExporter implements SpanExporter {
  private exporter: SpanExporter;

  constructor(options: {
    baseUrl?: string;
    port?: number;
    apiKey?: string;
    forceHttp?: boolean;
    timeoutMillis?: number;
  } = {}) {
    let url = options.baseUrl ?? process?.env?.LMNR_BASE_URL;
    let port = options.port;
    let forceHttp = options.forceHttp ?? false;
    const key = options.apiKey ?? process?.env?.LMNR_PROJECT_API_KEY;

    // Determine headers - either from API key or OTEL env vars
    let headers: Record<string, string> = {};
    if (key) {
      headers = forceHttp
        ? { 'Authorization': `Bearer ${key}` }
        : { 'authorization': `Bearer ${key}` };
    } else {
      const otelHeaders = getOtelEnvVar('HEADERS');
      if (otelHeaders) {
        headers = parseOtelHeaders(otelHeaders);
      }
    }

    // Check for OTEL endpoint configuration
    const otelEndpoint = getOtelEnvVar('ENDPOINT');
    if (otelEndpoint && !url) {
      url = otelEndpoint;

      // Determine protocol from OTEL env vars
      const otelProtocol = getOtelEnvVar('PROTOCOL') || 'grpc/protobuf';
      const otelExporter = process?.env?.OTEL_EXPORTER;
      forceHttp = otelProtocol === 'http/protobuf'
        || otelProtocol === 'http/json'
        || otelExporter === 'otlp_http';
    } else if (otelEndpoint && url) {
      logger.warn(
        'OTEL_ENDPOINT is set, but Laminar base URL is also set. Ignoring OTEL_ENDPOINT.',
      );
    }

    // Set default URL if not provided
    if (!url) {
      // If we have an API key (traditional Laminar mode), default to Laminar API
      if (key) {
        url = 'https://api.lmnr.ai';
      } else {
        // If we're using OTEL mode (no API key), we must have OTEL_ENDPOINT
        // This should have been validated earlier, but just in case
        throw new Error(
          'Laminar base URL is not set and OTEL_ENDPOINT is not set. Please either\n' +
          '- set the LMNR_BASE_URL environment variable\n' +
          '- set the OTEL_ENDPOINT environment variable\n' +
          '- pass the baseUrl parameter to Laminar.initialize',
        );
      }
    }

    // Calculate port
    if (!port) {
      port = url.match(/:\d{1,5}$/g)
        ? parseInt(url.match(/:\d{1,5}$/g)![0].slice(1))
        : (forceHttp ? 443 : 8443);
    }

    const urlWithoutSlash = url.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');

    if (forceHttp) {
      this.exporter = new ExporterHttp({
        url: `${urlWithoutSlash}:${port}/v1/traces`,
        headers,
        timeoutMillis: options.timeoutMillis ?? 30000,
      });
    } else {
      const metadata = new Metadata();
      Object.entries(headers).forEach(([key, value]) => {
        metadata.set(key, value);
      });
      this.exporter = new ExporterGrpc({
        url: `${urlWithoutSlash}:${port}`,
        metadata,
        timeoutMillis: options.timeoutMillis ?? 30000,
      });
    }
  }

  export(
    items: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ) {
    // ==== //
    // OTel v2 has renamed the instrumentationLibrary field to instrumentationScope,
    // but spans may be created by older versions of the SDK that don't have that change.
    // This is a small hack to support those older spans.
    items.forEach(makeSpanOtelV2Compatible);
    // ==== //

    return this.exporter.export(items, resultCallback);
  }

  async shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.();
  }
}

