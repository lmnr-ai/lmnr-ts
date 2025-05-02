// This class could be just an initialization of the OTLP exporter,
// but OTel v2 has some breaking changes, so we're applying
// a small backward-compatibility fix here.

import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { Metadata } from "@grpc/grpc-js";

import {
  OTLPTraceExporter as ExporterGrpc
} from "@opentelemetry/exporter-trace-otlp-grpc";
import {
  OTLPTraceExporter as ExporterHttp
} from "@opentelemetry/exporter-trace-otlp-proto";
import { ExportResult } from "@opentelemetry/core";
import { makeSpanOtelV2Compatible } from "./compat";

export class LaminarSpanExporter implements SpanExporter {
  private exporter: SpanExporter;

  constructor(options: {
    baseUrl?: string;
    port?: number;
    apiKey?: string;
    forceHttp?: boolean;
    timeoutMillis?: number;
  }) {
    const url = options.baseUrl ?? process?.env?.LMNR_BASE_URL ?? 'https://api.lmnr.ai';
    const port = options.port ?? (
      url.match(/:\d{1,5}$/g)
        ? parseInt(url.match(/:\d{1,5}$/g)![0].slice(1))
        : (options.forceHttp ? 443 : 8443));
    const urlWithoutSlash = url.replace(/\/$/, '').replace(/:\d{1,5}$/g, '');

    const key = options.apiKey ?? process?.env?.LMNR_PROJECT_API_KEY;
    if (key === undefined) {
      throw new Error(
        'Please initialize the Laminar object with your project API key ' +
        'or set the LMNR_PROJECT_API_KEY environment variable',
      );
    }

    if (options.forceHttp) {
      console.log('Using HTTP exporter with key', key);
      console.log('URL', `${urlWithoutSlash}:${port}/v1/traces`);
      this.exporter = new ExporterHttp({
        url: `${urlWithoutSlash}:${port}/v1/traces`,
        headers: {
          'Authorization': `Bearer ${key}`
        },
        timeoutMillis: options.timeoutMillis ?? 30000,
      });
    } else {
      const metadata = new Metadata();
      metadata.set('authorization', `Bearer ${key}`);
      this.exporter = new ExporterGrpc({
        url: `${urlWithoutSlash}:${port}`,
        metadata,
        timeoutMillis: options.timeoutMillis ?? 30000,
      });
    }
  }

  async export(items: ReadableSpan[], resultCallback: (result: ExportResult) => void): Promise<void> {
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

