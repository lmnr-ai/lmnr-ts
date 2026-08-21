"use client";

import { useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

// Stable, unique id per message, assigned once at creation time. A render-time
// id (randomUUID() in the key) would change identity on every render and remount
// every bubble; the array index would reuse identity across different messages.
let messageCounter = 0;
const nextMessageId = () => `message-${messageCounter++}`;

const INITIAL_MESSAGES: Message[] = [
  {
    id: nextMessageId(),
    role: "assistant",
    content:
      "Hello, I'm here to help. Feel free to share your thoughts or concerns, and I'll listen and provide support. What's on your mind today?",
  },
];

// Ref callback: React invokes it when the node mounts, i.e. exactly when a new
// message (or the typing indicator) is appended. Defined at module scope so its
// identity is stable across renders — otherwise React would detach/reattach it
// on every render and scroll on every keystroke.
const scrollIntoView = (node: HTMLDivElement | null) => {
  node?.scrollIntoView({ behavior: "smooth" });
};

export default function ChatUI() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() === "") return;

    // Add user message
    const userMessage: Message = {
      id: nextMessageId(),
      role: "user",
      content: input,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Call API
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [...messages, userMessage],
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get a response");
      }

      const data = await response.json();

      // Add assistant's response
      setMessages((prev) => [
        ...prev,
        { id: nextMessageId(), role: "assistant", content: data.message },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId(),
          role: "assistant",
          content:
            "I'm sorry, I'm having trouble responding right now. Please try again in a moment.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col w-full max-w-2xl mx-auto h-[70vh]">
      <div className="bg-white dark:bg-gray-800 rounded-t-lg p-4 border border-gray-200 dark:border-gray-700 overflow-y-auto grow">
        <div className="space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              ref={scrollIntoView}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  message.role === "user"
                    ? "bg-blue-500 text-white rounded-br-none"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-bl-none"
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}
          {isLoading && (
            <div ref={scrollIntoView} className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-bl-none">
                <div className="flex space-x-2">
                  <div className="w-2 h-2 rounded-full bg-gray-400 animate-pulse"></div>
                  <div
                    className="w-2 h-2 rounded-full bg-gray-400 animate-pulse"
                    style={{ animationDelay: "0.2s" }}
                  ></div>
                  <div
                    className="w-2 h-2 rounded-full bg-gray-400 animate-pulse"
                    style={{ animationDelay: "0.4s" }}
                  ></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex items-center border border-gray-200 dark:border-gray-700 rounded-b-lg overflow-hidden"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message here..."
          className="grow mt-2 p-4 focus:outline-none bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 resize-none"
          disabled={isLoading}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="bg-blue-500 hover:bg-blue-600 text-white p-4 disabled:opacity-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            role="img"
            aria-label="submit-button"
          >
            <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
