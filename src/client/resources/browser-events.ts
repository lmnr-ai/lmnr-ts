import { version as SDK_VERSION } from '../../../package.json';
import { getLangVersion } from "../../version";
import { BaseResource } from "./index";

export class BrowserEventsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  public async send({
    sessionId,
    traceId,
    events,
  }: {
    sessionId: string;
    traceId: string;
    events: Record<string, any>[];
  }): Promise<void> {
    const payload = {
      sessionId,
      traceId,
      events,
      source: getLangVersion() ?? 'javascript',
      sdkVersion: SDK_VERSION,
    };

    const jsonString = JSON.stringify(payload);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const compressedStream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    const compressedResponse = new Response(compressedStream);
    const compressedData = await compressedResponse.arrayBuffer();

    const response = await fetch(this.baseHttpUrl + "/v1/browser-sessions/events", {
      method: "POST",
      headers: {
        ...this.headers(),
        'Content-Encoding': 'gzip',
      },
      body: compressedData,
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
