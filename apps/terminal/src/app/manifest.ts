import type { MetadataRoute } from "next";

// Web app manifest, emitted by Next at /manifest.webmanifest. Makes the
// terminal installable to the home screen / app dock — the product framing is
// "install the terminal; your tmux sessions are always there" (they survive the
// browser and the gateway). See docs/PWA-PLAN.md.
//
// theme/background = the warm near-charcoal canvas (#2b2622) so the OS chrome
// and splash match the app exactly (matches viewport.themeColor in layout.tsx).
// orientation stays "any" — a terminal must never lock rotation.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sparklab Terminal",
    short_name: "Terminal",
    description: "Web terminal with persistent tmux sessions",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    theme_color: "#2b2622",
    background_color: "#2b2622",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // Separate maskable entry (full-bleed square, glyph in the safe zone) so
      // Android's adaptive-icon mask doesn't clip a rounded-corner artwork.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
