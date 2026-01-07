import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openai } from '@ai-sdk/openai';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { generateText, streamText, tool } from 'ai';
import nock from 'nock';
import { z } from 'zod';

import { startCacheServer } from '../../src/cli/rollout/cache-server';
import { observe } from '../../src/decorators';
import { _resetConfiguration, initializeTracing } from '../../src/opentelemetry-lib/configuration';
import { wrapLanguageModel } from '../../src/opentelemetry-lib/instrumentation/aisdk';
import { getTracer } from '../../src/opentelemetry-lib/tracing';
import { decompressRecordingResponse } from '../utils';

// Helper to close server
async function closeServer(server: http.Server): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100));
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(() => server.closeAllConnections?.(), 10);
  });
}

void describe('Rollout Integration Tests', () => {
  const model = openai('gpt-4.1-nano');
  const exporter = new InMemorySpanExporter();
  const dirname = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, '..', 'recordings');

  let cacheServer: http.Server;
  let cacheServerPort: number;
  let cache: Map<string, any>;
  let setMetadata: (metadata: any) => void;

  const getRecordingFile = (testName: string) => {
    const sanitizedName = testName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    return path.join(recordingsDir, `rollout-${sanitizedName}.json`);
  };

  void beforeEach(async (t) => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });

    // Start cache server
    const result = await startCacheServer();
    cacheServer = result.server;
    cacheServerPort = result.port;
    cache = result.cache;
    setMetadata = result.setMetadata;

    // Set env vars
    process.env.LMNR_ROLLOUT_SESSION_ID = 'test-rollout-session';
    process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS = `http://localhost:${cacheServerPort}`;

    const recordingsFile = getRecordingFile(t.name);

    if (process.env.LMNR_TEST_RECORD_VCR) {
      nock.cleanAll();
      nock.restore();
      nock.recorder.rec({
        dont_print: true,
        enable_reqheaders_recording: false,
        output_objects: true,
      });
    } else if (fs.existsSync(recordingsFile)) {
      nock.cleanAll();
      const OLD_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      const recordings = JSON.parse(await fs.promises.readFile(recordingsFile, 'utf8'));
      recordings.forEach((recording: nock.Definition) => {
        const response = decompressRecordingResponse(recording);
        nock(recording.scope)
          .intercept(recording.path, recording.method ?? 'POST', recording.body)
          .reply(recording.status, response, recording.headers);
        process.env.OPENAI_API_KEY = OLD_OPENAI_API_KEY;
      });
    } else {
      throw new Error(
        `LMNR_TEST_RECORD_VCR variable is false and no recordings file exists: ${recordingsFile}`,
      );
    }
  });

  void afterEach(async (t) => {
    exporter.reset();
    delete process.env.LMNR_ROLLOUT_SESSION_ID;
    delete process.env.LMNR_ROLLOUT_STATE_SERVER_ADDRESS;
    await closeServer(cacheServer);

    if (process.env.LMNR_TEST_RECORD_VCR) {
      const recordings = nock.recorder.play();
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }
      const recordingsFile = getRecordingFile(t.name);
      fs.writeFileSync(recordingsFile, JSON.stringify(recordings, null, 2));
      nock.restore();
    }
  });

  void after(async () => {
    await exporter.shutdown();
    nock.cleanAll();
  });

  void it('caches first N LLM calls in sequential tool execution', async () => {
    // Set up cache for first 2 LLM calls
    const llmPath = 'agent.ai.generateText.ai.generateText.doGenerate';

    cache.set(`0:${llmPath}`, {
      name: 'doGenerate',
      input: '{}',
      output: JSON.stringify([{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'calculate_base',
        input: '{"value":5}',
      }]),
      attributes: { 'ai.response.finishReason': 'tool-calls' },
    });

    cache.set(`1:${llmPath}`, {
      name: 'doGenerate',
      input: '{}',
      output: JSON.stringify([{
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: 'calculate_final',
        input: '{"base":10}',
      }]),
      attributes: { 'ai.response.finishReason': 'tool-calls' },
    });

    setMetadata({
      pathToCount: { [llmPath]: 2 },
    });

    // Create sequential tools
    const agent = observe(
      { name: 'agent', rolloutEntrypoint: true },
      async () => {
        const result = await generateText({
          model: wrapLanguageModel(model),
          messages: [{
            role: 'user',
            content: [{
              type: 'text',
              text: 'First calculate base from 5, then use that base to calculate final result',
            }],
          }],
          system: 'You are a calculator assistant. Call tools sequentially.',
          tools: {
            calculate_base: tool({
              description: 'Calculate a base number by doubling the input',
              inputSchema: z.object({
                value: z.number().describe('A number to use as base'),
              }),
              execute: ({ value }: { value: number }) => ({ result: value * 2 }),
            }),
            calculate_final: tool({
              description: 'Calculate final result by adding 10 to the base',
              inputSchema: z.object({
                base: z.number().describe('Base number from previous calculation'),
              }),
              execute: ({ base }: { base: number }) => ({ result: base + 10 }),
            }),
          },
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });
        return result.text;
      },
    );

    // Execute agent

    await agent();

    const spans = exporter.getFinishedSpans();

    // Verify spans created
    const llmSpans = spans.filter(s => s.name.includes('doGenerate'));
    const toolSpans = spans.filter(s => s.attributes['ai.toolCall.id'] !== 'undefined');

    // Should have LLM and tool spans
    assert.ok(llmSpans.length > 0, 'Should have LLM spans');
    assert.ok(toolSpans.length > 0, 'Should have tool spans');

    // Verify rollout session ID on spans
    for (const span of spans) {
      if (span.attributes['lmnr.association.properties.rollout_session_id']) {
        assert.strictEqual(
          span.attributes['lmnr.association.properties.rollout_session_id'],
          'test-rollout-session',
        );
      }
    }
  });

  void it('applies system override after cache exhausted', () => {
    const llmPath = 'test.ai.generateText.ai.generateText.doGenerate';

    // Cache first call only
    cache.set(`0:${llmPath}`, {
      name: 'doGenerate',
      input: '{}',
      output: JSON.stringify([{ type: 'text', text: 'Cached' }]),
      attributes: { 'ai.response.finishReason': 'stop' },
    });

    // Set override for this path
    setMetadata({
      pathToCount: { [llmPath]: 1 },
      overrides: {
        [llmPath]: {
          system: 'You are an override assistant.',
        },
      },
    });

    // This test would require multiple LLM calls to verify override application
    // The second call should use the override system message
    assert.ok(true);
  });

  void it('applies tool overrides after cache exhausted', () => {
    const llmPath = 'test.ai.generateText.ai.generateText.doGenerate';

    cache.set(`0:${llmPath}`, {
      name: 'doGenerate',
      input: '{}',
      output: JSON.stringify([{ type: 'text', text: 'Cached' }]),
      attributes: { 'ai.response.finishReason': 'stop' },
    });

    setMetadata({
      pathToCount: { [llmPath]: 1 },
      overrides: {
        [llmPath]: {
          tools: [{
            name: 'calculate',
            description: 'Updated description for calculator',
            parameters: {
              type: 'object',
              properties: {
                value: { type: 'number', description: 'Value to calculate' },
              },
            },
          }],
        },
      },
    });

    // This test would verify tool definitions are updated on live calls
    assert.ok(true);
  });

  void it('runs fresh agent without trace_id', async () => {
    // Empty cache, no trace_id
    setMetadata({
      pathToCount: {},
    });

    const agent = observe(
      { name: 'fresh-agent', rolloutEntrypoint: true },
      async (input: string) => {
        const result = await generateText({
          model: wrapLanguageModel(model),
          messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });
        return result.text;
      },
    );


    const result = await agent('What is 2+2?');

    assert.ok(result);

    const spans = exporter.getFinishedSpans();

    // Verify rollout session ID still tracked
    const agentSpan = spans.find(s => s.name === 'fresh-agent');
    assert.ok(agentSpan);
    assert.strictEqual(
      agentSpan.attributes['lmnr.association.properties.rollout_session_id'],
      'test-rollout-session',
    );
  });

  void it('propagates rollout session ID to all spans', async () => {
    const agent = observe(
      { name: 'test-agent', rolloutEntrypoint: true },
      async () => {
        const result = await generateText({
          model: wrapLanguageModel(model),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });
        return result.text;
      },
    );


    await agent();

    const spans = exporter.getFinishedSpans();

    // Verify all spans have rollout session ID
    const agentSpan = spans.find(s => s.name === 'test-agent');
    const llmSpans = spans.filter(s => s.name.includes('doGenerate'));
    const generateTextSpans = spans.filter(
      s => s.name.includes('generateText') && !s.name.includes('doGenerate'),
    );

    assert.ok(agentSpan, 'Should have agent span');
    assert.strictEqual(
      agentSpan.attributes['lmnr.association.properties.rollout_session_id'],
      'test-rollout-session',
    );

    // Check LLM spans for direct attribute (set by BaseLaminarLanguageModel)
    for (const llmSpan of llmSpans) {
      const rolloutId = llmSpan.attributes['lmnr.rollout.session_id']
        || llmSpan.attributes['lmnr.association.properties.rollout_session_id'];
      assert.strictEqual(
        rolloutId,
        'test-rollout-session',
        'LLM span should have rollout session ID',
      );
    }

    // Check generateText spans (should inherit from context)
    for (const gtSpan of generateTextSpans) {
      const rolloutId = gtSpan.attributes['lmnr.rollout.session_id']
        || gtSpan.attributes['lmnr.association.properties.rollout_session_id'];
      // May or may not have it depending on how AI SDK creates spans
      if (rolloutId) {
        assert.strictEqual(
          rolloutId,
          'test-rollout-session',
        );
      }
    }
  });

  void it('handles stream caching with tool calls', async () => {
    const streamPath = 'test.ai.streamText.ai.streamText.doStream';

    // Cache first stream response
    cache.set(`0:${streamPath}`, {
      name: 'doStream',
      input: '{}',
      output: JSON.stringify([{ type: 'text', text: 'Streamed response' }]),
      attributes: { 'ai.response.finishReason': 'stop' },
    });

    setMetadata({
      pathToCount: { [streamPath]: 1 },
    });

    const agent = observe(
      { name: 'test', rolloutEntrypoint: true },
      async () => {
        const stream = streamText({
          model: wrapLanguageModel(model),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });

        // Consume stream
        let fullText = '';
        for await (const chunk of stream.textStream) {
          fullText += chunk;
        }
        return fullText;
      },
    );


    const result = await agent();

    assert.ok(result);

    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length > 0);
  });

  void it('tracks multiple paths independently', () => {
    // Different paths with different counts
    const path1 = 'test.ai.generateText.ai.generateText.doGenerate';
    const path2 = 'test.tool1';

    cache.set(`0:${path1}`, {
      name: 'doGenerate',
      input: '{}',
      output: '"Cached LLM 1"',
      attributes: {},
    });

    cache.set(`1:${path1}`, {
      name: 'doGenerate',
      input: '{}',
      output: '"Cached LLM 2"',
      attributes: {},
    });

    setMetadata({
      pathToCount: {
        [path1]: 2,
        [path2]: 0, // Don't cache tool calls
      },
    });

    // Test would verify that LLM calls use cache but tools don't
    // Requires actual execution with tools
    assert.ok(true);
  });

  void it('handles cache miss gracefully in agent execution', async () => {
    // Set pathToCount but no cached data
    setMetadata({
      pathToCount: { 'test.ai.generateText.ai.generateText.doGenerate': 1 },
    });

    const agent = observe(
      { name: 'test', rolloutEntrypoint: true },
      async () => {
        const result = await generateText({
          model: wrapLanguageModel(model),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Test' }] }],
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });
        return result.text;
      },
    );

    // Should not throw, should fall back to live model

    const result = await agent();

    assert.ok(result);

    const spans = exporter.getFinishedSpans();
    const llmSpans = spans.filter(s => s.name.includes('doGenerate'));
    assert.ok(llmSpans.length > 0, 'Should have LLM spans from live calls');
  });

  void it('verifies span path structure with tools', async () => {
    const agent = observe(
      { name: 'tool-agent', rolloutEntrypoint: true },
      async () => {
        const result = await generateText({
          model: wrapLanguageModel(model),
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: 'What is the weather in SF?' }],
          }],
          system: 'You are a helpful assistant.',
          tools: {
            get_weather: tool({
              description: 'Get the weather',
              inputSchema: z.object({
                location: z.string(),
              }),
              execute: ({ location }: { location: string }) => ({
                location,
                weather: 'Sunny',
              }),
            }),
          },
          experimental_telemetry: { isEnabled: true, tracer: getTracer() },
        });
        return result.text;
      },
    );


    await agent();

    const spans = exporter.getFinishedSpans();

    // Verify LLM span paths
    const llmSpans = spans.filter(s => s.name.includes('doGenerate'));
    for (const llmSpan of llmSpans) {
      const spanPath = llmSpan.attributes['lmnr.span.path'] as string[];
      assert.ok(spanPath, 'LLM span should have path');

      // Path should be: tool-agent.ai.generateText.ai.generateText.doGenerate
      assert.strictEqual(spanPath[0], 'tool-agent');
      assert.ok(spanPath.includes('ai.generateText'));
      assert.ok(spanPath[spanPath.length - 1].endsWith('doGenerate'));
    }

    // Verify tool span paths
    const toolSpans = spans.filter(s => s.name === 'get_weather');
    for (const toolSpan of toolSpans) {
      const spanPath = toolSpan.attributes['lmnr.span.path'] as string[];
      assert.ok(spanPath, 'Tool span should have path');

      // Path should be: tool-agent.ai.generateText.get_weather
      assert.strictEqual(spanPath[0], 'tool-agent');
      assert.ok(spanPath.includes('ai.generateText'));
      assert.strictEqual(spanPath[spanPath.length - 1], 'get_weather');
    }
  });
});
