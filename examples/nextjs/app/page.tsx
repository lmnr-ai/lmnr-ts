import ChatUI from "@/components/chat-ui";

export default function Home() {
  return (
    <div className="grid grid-rows-[auto_1fr_auto] min-h-screen p-4 sm:p-6 font-[family-name:var(--font-geist-sans)]">
      <header className="py-4 text-center">
        <h1 className="text-2xl font-bold text-blue-600 mb-1">Therapy Chat</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-lg mx-auto">
          A safe space to share your thoughts and receive supportive guidance.
          Your conversation is private and confidential.
        </p>
      </header>
      <main className="w-full max-w-4xl mx-auto my-4">
        <ChatUI />
      </main>
      <footer className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>AI-powered support | Not a substitute for professional medical advice</p>
      </footer>
    </div>
  );
}
