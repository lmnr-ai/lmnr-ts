import { anthropic } from "@/lib/anthropic";
import { openai } from "@/lib/openai";

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, provider } = body;

    const llmProvider = provider ?? process.env.LLM_PROVIDER ?? "openai";

    // Create system message with therapeutic instructions
    const systemMessage = {
      role: 'system',
      content: `You are an AI-powered therapist assistant. Respond with empathy, understanding, and professionalism.
Your goal is to provide supportive responses that help the user process their feelings and thoughts.
Never give medical advice or diagnose conditions.`
    };

    let response;

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
      response = completion.content[0].type === "text" ? completion.content[0].text : "";
    } else {
      throw new Error(`Unsupported provider: ${llmProvider}`);
    }
    return NextResponse.json({ message: response });

  } catch (error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
