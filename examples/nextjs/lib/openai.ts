import { Laminar } from "@lmnr-ai/lmnr";
import { OpenAI } from "openai";

Laminar.patch({
  OpenAI: OpenAI,
});

const openai = new OpenAI();

export { openai };
