import type { Metadata } from "next";

import { Providers } from "@/components/providers";

import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Sparklab",
  description: "Sparklab platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
