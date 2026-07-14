import type { Metadata, Viewport } from "next";

import { Providers } from "@/components/providers";

import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Sparklab Terminal",
  description: "Web terminal with persistent tmux sessions",
};

// Mobile UX spec §2.1/§5: viewport-fit=cover makes env(safe-area-inset-*)
// non-zero on notched devices; interactive-widget=resizes-content makes
// Android Chrome shrink the layout viewport when the keyboard opens (iOS is
// handled by the visualViewport fallback). No maximumScale/userScalable —
// pinch-zoom stays available for accessibility; iOS input auto-zoom is fixed
// via 16px mobile input font in globals.css instead.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#2b2622",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      {/* suppressHydrationWarning: browser extensions (e.g. ColorZilla's
          cz-shortcut-listen) inject attributes on <body> before React
          hydrates; suppression is attribute-only and one level deep. */}
      <body
        className="h-dvh overflow-hidden antialiased"
        suppressHydrationWarning
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
