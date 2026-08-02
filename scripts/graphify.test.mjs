import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  check,
  isSafeGraphSource,
  repositoryState,
  sourceState,
  validateWiki,
} from "./graphify.mjs";

test("graph sources reject generated and machine-specific paths", () => {
  assert.equal(isSafeGraphSource("apps/terminal/src/app/page.tsx"), true);
  assert.equal(isSafeGraphSource("apps/e2e/playwright-report/trace.js"), false);
  assert.equal(isSafeGraphSource(".env.production"), false);
  assert.equal(isSafeGraphSource("/tmp/project/app.ts"), false);
});

test("sourceState ignores secrets and includes graphify configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "graphify-state-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, ".graphifyignore"), "coverage\n");
  writeFileSync(join(root, ".env"), "TOKEN=do-not-hash\n");

  const first = sourceState(root, "code");
  assert.deepEqual(Object.keys(first.files), [".graphifyignore", "app.ts"]);
  writeFileSync(join(root, ".env"), "TOKEN=changed\n");
  assert.equal(sourceState(root, "code").fingerprint, first.fingerprint);
  writeFileSync(join(root, ".graphifyignore"), "coverage\ndist\n");
  assert.notEqual(sourceState(root, "code").fingerprint, first.fingerprint);
});

test("repositoryState only advances semantic state when explicitly certified", () => {
  const root = mkdtempSync(join(tmpdir(), "graphify-semantic-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "README.md"), "first\n");

  const unknown = repositoryState(root);
  assert.equal(unknown.semantic, null);
  const certified = repositoryState(root, unknown, true);
  writeFileSync(join(root, "README.md"), "second\n");
  const preserved = repositoryState(root, certified, false);
  assert.equal(preserved.semantic.fingerprint, certified.semantic.fingerprint);
  assert.notEqual(
    sourceState(root, "semantic").fingerprint,
    preserved.semantic.fingerprint,
  );
});

test("check fails when semantic inputs changed after certification", () => {
  const root = mkdtempSync(join(tmpdir(), "graphify-check-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "README.md"), "first\n");
  mkdirSync(join(root, "graphify-out/wiki"), { recursive: true });
  writeFileSync(
    join(root, "graphify-out/graph.json"),
    '{"nodes":[],"links":[]}\n',
  );
  writeFileSync(join(root, "graphify-out/GRAPH_REPORT.md"), "# Report\n");
  writeFileSync(join(root, "graphify-out/wiki/index.md"), "# Index\n");
  writeFileSync(
    join(root, "graphify-out/.repo-state.json"),
    `${JSON.stringify(repositoryState(root, null, true))}\n`,
  );

  assert.deepEqual(check(root), []);
  writeFileSync(join(root, "README.md"), "second\n");
  assert.match(check(root).join("\n"), /semantic content is stale/);
});

test("validateWiki finds missing links and orphaned articles", () => {
  const wiki = mkdtempSync(join(tmpdir(), "graphify-wiki-"));
  writeFileSync(
    join(wiki, "index.md"),
    "[One](One.md)\n[Missing](Missing.md)\n",
  );
  writeFileSync(join(wiki, "One.md"), "# One\n");
  writeFileSync(join(wiki, "Orphan.md"), "# Orphan\n");

  assert.deepEqual(validateWiki(wiki), [
    "Index link is missing: Missing.md",
    "Wiki article is not indexed: Orphan.md",
  ]);
});
