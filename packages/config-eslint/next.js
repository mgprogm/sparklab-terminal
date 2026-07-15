import base from "./base.js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...base,
  {
    // Next.js specific overrides
    rules: {
      // Allow default exports for pages/layouts
      "import-x/no-default-export": "off",
    },
  },
  {
    // Ignore Next.js build output (.next, plus NEXT_DIST_DIR variants like .next-prod/.next-e2e)
    ignores: [".next*/", "next-env.d.ts"],
  },
];
