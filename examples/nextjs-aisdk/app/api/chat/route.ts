import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages } = body;

    const systemMessage = `You are an AI-powered therapist assistant. Respond with empathy, understanding, and professionalism.
Your goal is to provide supportive responses that help the user process their feelings and thoughts.
Never give medical advice or diagnose conditions.`;

    const response = await generateText({
      model: openai("gpt-5-nano"),
      instructions: systemMessage,
      messages,
    });

    return NextResponse.json({ message: response.text });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to process request. ${error}` },
      { status: 500 },
    );
  }
}
