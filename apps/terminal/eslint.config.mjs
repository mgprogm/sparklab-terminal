import next from "@sparklab/config-eslint/next";

export default [
  // public/ is served verbatim by Next and holds static assets (incl. the
  // hand-written service worker, which uses ServiceWorkerGlobalScope globals);
  // it is not application source and should not be linted.
  { ignores: ["public/**"] },
  ...next,
  {
    // scripts/ holds Node build tooling (the vscode-icons generator), not app
    // source, so it needs Node globals the browser config doesn't provide.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
];
