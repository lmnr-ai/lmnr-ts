import type { Metadata } from "next";
import { Inter, Noto_Sans_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-geist",
  subsets: ["latin"],
});

const geistMono = Noto_Sans_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Therapy Chat - AI Support",
  description: "A supportive space to share your thoughts and receive guidance",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
