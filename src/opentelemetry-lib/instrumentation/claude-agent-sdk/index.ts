import type * as ClaudeAgentSDK from "@anthropic-ai/claude-agent-sdk";
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
  originalQuery: typeof ClaudeAgentSDK.query,
): typeof ClaudeAgentSDK.query {
  return (params: {
    prompt: string | AsyncIterable<ClaudeAgentSDK.SDKUserMessage>,
    options?: ClaudeAgentSDK.Options,
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
      const collected: ClaudeAgentSDK.SDKMessage[] = [];

      try {
        // Start proxy (uses reference counting for concurrent requests)
        await startProxy();

        // Publish span context
        const proxyBaseUrl = getProxyBaseUrl();
        if (proxyBaseUrl) {
          await Laminar.withSpan(span, () => {
            setTraceToProxy();
          });
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

    return generator() as ClaudeAgentSDK.Query;
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

  public manuallyInstrument(claudeAgentModule: { query?: typeof ClaudeAgentSDK.query }) {
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
    return (original: Function) =>
      instrumentClaudeAgentQuery(original as typeof ClaudeAgentSDK.query);
  }

  private patch(moduleExports: typeof ClaudeAgentSDK): any {
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

  private unpatch(moduleExports: typeof ClaudeAgentSDK): void {
    diag.debug('Unpatching @anthropic-ai/claude-agent-sdk');

    // Unwrap the query function
    this._unwrap(moduleExports, 'query');
  }
}
/* eslint-enable
  @typescript-eslint/no-unsafe-function-type
*/

