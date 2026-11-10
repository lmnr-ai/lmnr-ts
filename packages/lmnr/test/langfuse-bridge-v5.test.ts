/**
 * The Langfuse bridge suite (`langfuse-bridge/suite.ts`) on @langfuse/* 5.x,
 * installed as the `@langfuse/*-v5` devDependency aliases.
 */
import * as core from "@langfuse/core-v5";
import * as langchain from "@langfuse/langchain-v5";
import * as openai from "@langfuse/openai-v5";
import * as otel from "@langfuse/otel-v5";
import * as tracing from "@langfuse/tracing-v5";

import { langfuseBridgeSuite } from "./langfuse-bridge/suite";

langfuseBridgeSuite({ major: 5, core, tracing, otel, openai, langchain });
