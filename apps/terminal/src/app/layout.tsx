import type { Metadata } from "next";

import { Providers } from "@/components/providers";

import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Sparklab Terminal",
  description: "Web terminal with persistent tmux sessions",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="h-screen overflow-hidden antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
