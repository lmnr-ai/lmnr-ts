import * as anthropic from "@anthropic-ai/sdk";

import { Laminar } from "@lmnr-ai/lmnr";

Laminar.patch({
    anthropic: anthropic
});

const anthropicClient = new anthropic.Anthropic();

export { anthropicClient as anthropic };
