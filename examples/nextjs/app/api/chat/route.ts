import { type NextRequest, NextResponse } from "next/server";
import { anthropic } from "@/lib/anthropic";
import { openai } from "@/lib/openai";

type ModelMessage = {
  role: "user" | "assistant";
  content: string;
};

// Keep only the fields the providers accept — clients may carry extra UI-only
// fields (e.g. a React key id) that Anthropic/OpenAI reject as unknown.
const toModelMessages = (messages: ModelMessage[]): ModelMessage[] =>
  messages.map(({ role, content }) => ({ role, content }));

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { provider } = body;
    const messages = toModelMessages(body.messages ?? []);

    const llmProvider = provider ?? process.env.LLM_PROVIDER ?? "openai";

    // Create system message with therapeutic instructions
    const systemMessage = {
      role: "system" as const,
      content: `You are an AI-powered therapist assistant. Respond with empathy, understanding, and professionalism.
Your goal is to provide supportive responses that help the user process their feelings and thoughts.
Never give medical advice or diagnose conditions.`,
    };

    let response: string | null = null;

    if (llmProvider === "openai") {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-nano",
        messages: [systemMessage, ...messages],
      });
      response = completion.choices[0].message.content;
    } else if (llmProvider === "anthropic") {
      const completion = await anthropic.messages.create({
        model: "claude-3-5-haiku-latest",
        system: systemMessage.content,
        messages: messages,
        max_tokens: 1000,
      });
      response =
        completion.content[0].type === "text" ? completion.content[0].text : "";
    } else {
      throw new Error(`Unsupported provider: ${llmProvider}`);
    }
    return NextResponse.json({ message: response });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to process request. ${error}` },
      { status: 500 },
    );
  }
}
