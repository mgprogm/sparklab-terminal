import next from "@sparklab/config-eslint/next";

export default [
  // public/ is served verbatim by Next and holds static assets (incl. the
  // hand-written service worker, which uses ServiceWorkerGlobalScope globals);
  // it is not application source and should not be linted.
  { ignores: ["public/**"] },
  ...next,
];
