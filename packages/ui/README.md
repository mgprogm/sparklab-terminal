# @sparklab/ui

Shared UI component library for Sparklab apps. Built on [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4.

## Consuming in an app

### 1. Dependencies

```json
{
  "dependencies": {
    "@sparklab/ui": "workspace:*"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.1.10",
    "tailwindcss": "^4.1.10"
  }
}
```

### 2. `next.config.ts` — transpile the package

```ts
const nextConfig: NextConfig = {
  transpilePackages: ["@sparklab/ui"],
};
```

### 3. `globals.css` — import theme + scan for classes

Tailwind v4 uses CSS-first configuration. Your app's `globals.css` must:

1. Import Tailwind.
2. Import the shared theme tokens from `@sparklab/ui/globals.css`.
3. Add an `@source` glob pointing at the ui package so Tailwind scans its
   component files for utility classes (otherwise they get purged).

```css
@import "tailwindcss";
@import "@sparklab/ui/globals.css";

/* Path is relative to THIS file. Adjust the ../ count to reach the repo root. */
@source "../../../../packages/ui/src";
```

### 4. `postcss.config.mjs`

```js
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

### 5. Import components

```tsx
import { Button } from "@sparklab/ui/components/ui/button";
import { cn } from "@sparklab/ui/lib/utils";
```

## Adding components

This package uses shadcn's monorepo layout with `#` package imports. To add a
new component, run from the `packages/ui` directory:

```bash
npx shadcn@latest add <component-name>
```

The component lands in `src/components/ui/` and is immediately available to
consuming apps via `@sparklab/ui/components/ui/<name>`.

## Theme

Design tokens live in `src/styles/globals.css`. The dark theme is the default
(matching the terminal's warm-dark aesthetic). A light theme is defined for
future use.
