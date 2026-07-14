#!/usr/bin/env node
// Generate a GATEWAY_AUTH_PASSWORD_HASH value for production deploys.
//
//   pnpm --filter @sparklab/terminal-gateway hash-password        # prompts (no echo)
//   node scripts/hash-password.js '<password>'                    # non-interactive
//
// The argv form is for scripting; it leaves the password in shell history.
import { hashPassword, verifyPassword } from "../src/password.js";

function promptHidden(promptText) {
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (data += chunk));
      stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

let password = process.argv[2];
if (password === undefined) {
  password = await promptHidden("Password: ");
  const confirm = await promptHidden("Confirm:  ");
  if (password !== confirm) {
    console.error("Passwords do not match.");
    process.exit(1);
  }
}
if (!password) {
  console.error("Password must not be empty.");
  process.exit(1);
}

const hash = hashPassword(password);
if (!verifyPassword(password, hash)) {
  console.error("Self-check failed; refusing to emit hash.");
  process.exit(1);
}

// stdout carries ONLY the env line so it is pipeable; prompts went to stderr.
// Single quotes matter: the value contains `$`.
console.log(`GATEWAY_AUTH_PASSWORD_HASH='${hash}'`);
