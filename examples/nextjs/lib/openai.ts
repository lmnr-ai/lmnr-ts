import { OpenAI } from "openai";
import { Laminar } from "@lmnr-ai/lmnr";

const openai = new OpenAI();

Laminar.patch({
    OpenAI: OpenAI
});


export { openai };
