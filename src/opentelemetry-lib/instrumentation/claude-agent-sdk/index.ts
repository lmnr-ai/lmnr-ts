import { diag } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { SPAN_INPUT, SPAN_OUTPUT } from "../../tracing/attributes";
import {
  forceReleaseProxy,
  getProxyBaseUrl,
  releaseProxy,
  setTraceToProxy,
  startProxy,
} from "./proxy";

// Re-export forceReleaseProxy for cleanup in Laminar.shutdown()
export { forceReleaseProxy };

const logger = initializeLogger();

/**
 * Create an instrumented version of the claude-agent-sdk query function.
 * This can be used when importing the query function before Laminar initialization.
 *
 * @param originalQuery - The original query function from claude-agent-sdk
 * @returns The instrumented query function
 */
export function instrumentClaudeAgentQuery(
  originalQuery: any, // typeof ClaudeAgentSDK.query
): any { // typeof ClaudeAgentSDK.Query
  return (params: {
    prompt: string | AsyncIterable<any>, // AsyncIterable<ClaudeAgentSDK.SDKUserMessage>
    options?: any, // ClaudeAgentSDK.Options
  }) => {
    const span = Laminar.startSpan({
      name: 'query',
      spanType: 'DEFAULT',
    });

    span.setAttribute(
      SPAN_INPUT,
      JSON.stringify({ prompt: typeof params.prompt === 'string' ? params.prompt : '<stream>' }),
    );

    const generator = async function* () {
      const collected: any[] = []; // ClaudeAgentSDK.SDKMessage[]

      try {
        // Start proxy (uses reference counting for concurrent requests)
        await startProxy({
          env: params.options?.env ?? process.env,
        });

        // Publish span context
        const proxyBaseUrl = getProxyBaseUrl();
        logger.debug(`getProxyBaseUrl() result: ${proxyBaseUrl}`);
        if (proxyBaseUrl) {
          await Laminar.withSpan(span, () => {
            logger.debug('Setting trace to proxy...');
            setTraceToProxy();
          });
          if (params.options?.env) {
            params.options.env.ANTHROPIC_BASE_URL = proxyBaseUrl;
          }
        } else {
          logger.debug("No claude proxy server found. Skipping span context publication.");
        }

        // Call original and wrap the generator
        const originalGenerator = originalQuery(params);

        // Yield items and collect
        for await (const message of originalGenerator) {
          collected.push(message);
          yield message;
        }
      } catch (error) {
        await Laminar.withSpan(span, () => {
          span.recordException(error as Error);
        });
        throw error;
      } finally {
        // Release proxy (decrements ref count, only stops when count reaches 0)
        releaseProxy();
        span.setAttribute(SPAN_OUTPUT, JSON.stringify(collected));
        span.end();
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return generator() as any; // ClaudeAgentSDK.Query
  };
}

/* eslint-disable
  @typescript-eslint/no-unsafe-function-type
*/
export class ClaudeAgentSDKInstrumentation extends InstrumentationBase {
  constructor() {
    super(
      "@lmnr/claude-agent-instrumentation",
      SDK_VERSION,
      {
        enabled: true,
      },
    );
  }

  protected init(): InstrumentationModuleDefinition {
    const module = new InstrumentationNodeModuleDefinition(
      "@anthropic-ai/claude-agent-sdk",
      ['>=0.1.0'],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );

    return module;
  }

  // { query?: typeof ClaudeAgentSDK.query }
  public manuallyInstrument(claudeAgentModule: { query?: any }) {
    // Only instrument the query function if provided
    if (claudeAgentModule.query && typeof claudeAgentModule.query === 'function') {
      this._wrap(
        claudeAgentModule,
        'query',
        this.patchQuery(),
      );
    } else {
      logger.debug(
        'query function not found in claudeAgentSDK module, skipping instrumentation',
      );
    }
  }

  private patchQuery(): any {
    // casts to ClaudeAgentSDK.query
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return (original: Function) => instrumentClaudeAgentQuery(original as any);
  }

  private patch(moduleExports: any): any { // typeof ClaudeAgentSDK
    diag.debug('Patching @anthropic-ai/claude-agent-sdk');

    // Wrap the query function for automatic instrumentation
    if (moduleExports.query && typeof moduleExports.query === 'function') {
      this._wrap(
        moduleExports,
        'query',
        this.patchQuery(),
      );
    }

    return moduleExports;
  }

  private unpatch(moduleExports: any): void { // typeof ClaudeAgentSDK
    diag.debug('Unpatching @anthropic-ai/claude-agent-sdk');

    // Unwrap the query function
    this._unwrap(moduleExports, 'query');
  }
}
/* eslint-enable
  @typescript-eslint/no-unsafe-function-type
*/

