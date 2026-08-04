// Generate a bearer token for POST /api/push/hook-notify.
//
// This token is deliberately SEPARATE from GATEWAY_API_TOKEN/KANBAN_API_TOKEN:
// it gets embedded in a Claude Code / Codex CLI hook config on every machine
// that wants turn-finished notifications, which is a materially different (and
// less trusted) exposure than a manually-invoked MCP client, so it must not
// also grant Kanban/PM/Agentic access. See docs/HOOK-NOTIFICATIONS-SETUP.md.
//
//   node scripts/generate-hook-token.js
//   # or: pnpm --filter @sparklab/terminal-gateway generate-hook-token
import crypto from "node:crypto";

console.log(
  "# Hook-notify bearer token — add to apps/terminal-gateway/.env AND to",
);
console.log(
  "# the mode-600 notify.env on each machine running the hook script.",
);
console.log(`HOOK_NOTIFY_TOKEN=${crypto.randomBytes(32).toString("hex")}`);
