import base from "./base.js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...base,
  {
    settings: {
      react: {
        version: "detect",
      },
    },
  },
];
