import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { getTracer } from "@lmnr-ai/lmnr";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages } = body;

    // Create system message with therapeutic instructions
    const systemMessage = {
      role: 'system',
      content: `You are an AI-powered therapist assistant. Respond with empathy, understanding, and professionalism.
Your goal is to provide supportive responses that help the user process their feelings and thoughts.
Never give medical advice or diagnose conditions.`
    };

    // Use the messages parameter directly with the system message as the first element
    const response = await generateText({
      model: openai("gpt-5-nano"),
      messages: [systemMessage, ...messages],
      experimental_telemetry: {
        isEnabled: true,
        tracer: getTracer(),
      }
    });

    return NextResponse.json({ message: response.text });

  } catch (error) {
    console.error("Error in chat API:", error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
} 