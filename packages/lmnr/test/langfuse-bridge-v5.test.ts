/**
 * The Langfuse bridge suite (`langfuse-bridge/suite.ts`) on @langfuse/* 5.x,
 * installed as the `@langfuse/*-v5` devDependency aliases.
 */
import * as core from "@langfuse/core-v5";
import * as langchain from "@langfuse/langchain-v5";
import * as openai from "@langfuse/openai-v5";
import * as otel from "@langfuse/otel-v5";
import * as tracing from "@langfuse/tracing-v5";

import { type LangfuseSdk, langfuseBridgeSuite } from "./langfuse-bridge/suite";

// The suite is typed against 6.x. Older majors' classes are distinct types
// (protected members, narrower metadata), but the suite only calls APIs all
// three majors have.
langfuseBridgeSuite({
  major: 5,
  core,
  tracing,
  otel,
  openai,
  langchain,
} as unknown as LangfuseSdk);
