import { ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OTLPGRPCExporterConfigNode } from '@opentelemetry/otlp-grpc-exporter-base';

export class MonitoredOTLPExporter extends OTLPTraceExporter {
  private _timeoutMillis?: number;

  constructor(config: OTLPGRPCExporterConfigNode) {
    super(config);
    this._timeoutMillis = config.timeoutMillis;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const result = super.export(spans, resultCallback);
      console.log('OTLP Export result:', result);
      return result;
    } catch (error) {
      console.error('OTLP Export failed:', {
        error: (error as Error).message,
        spanCount: spans.length,
        timeoutSetting: this._timeoutMillis
      });

      throw error; // Re-throw to maintain original behavior
    }
  }
}

