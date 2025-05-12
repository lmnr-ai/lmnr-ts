import { OpenAI } from "openai";
import { Laminar } from "@lmnr-ai/lmnr";
Laminar.patch({
    OpenAI: OpenAI
});

const openai = new OpenAI();
export { openai };
