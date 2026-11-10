/**
 * The Langfuse bridge suite (`langfuse-bridge/suite.ts`) on @langfuse/* 4.x,
 * installed as the `@langfuse/*-v4` devDependency aliases.
 */
import * as core from "@langfuse/core-v4";
import * as langchain from "@langfuse/langchain-v4";
import * as openai from "@langfuse/openai-v4";
import * as otel from "@langfuse/otel-v4";
import * as tracing from "@langfuse/tracing-v4";

import { langfuseBridgeSuite } from "./langfuse-bridge/suite";

langfuseBridgeSuite({ major: 4, core, tracing, otel, openai, langchain });
