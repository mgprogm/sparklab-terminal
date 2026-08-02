#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OUTPUT_DIR = join(REPO_ROOT, "graphify-out");
const STATE_PATH = join(OUTPUT_DIR, ".repo-state.json");
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const EXCLUDED_PARTS = new Set([
  ".git",
  ".next",
  ".next-prod",
  ".turbo",
  "coverage",
  "data",
  "dist",
  "graphify-out",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const SEMANTIC_EXTENSIONS = new Set([
  ".html",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".yaml",
  ".yml",
]);

function isRelevantSource(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1)?.toLowerCase() ?? "";

  if (
    parts.some((part) => EXCLUDED_PARTS.has(part) || part.startsWith(".next-"))
  ) {
    return false;
  }
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    /(?:credential|secret)/i.test(basename) ||
    /\.(?:key|p12|pem|pfx)$/i.test(basename)
  ) {
    return false;
  }
  return (
    SOURCE_EXTENSIONS.has(extname(basename)) ||
    basename === "dockerfile" ||
    basename === ".graphifyignore"
  );
}

function isSemanticSource(path) {
  return SEMANTIC_EXTENSIONS.has(extname(path).toLowerCase());
}

export function sourceState(root = REPO_ROOT, kind = "all") {
  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(
      `Unable to enumerate repository sources with git: ${error.message}`,
    );
  }

  const files = output
    .split("\0")
    .filter(Boolean)
    .filter(isRelevantSource)
    .filter((path) =>
      kind === "semantic"
        ? isSemanticSource(path)
        : kind === "code"
          ? !isSemanticSource(path)
          : true,
    )
    .filter((path) => {
      const fullPath = resolve(root, path);
      return (
        fullPath.startsWith(`${resolve(root)}${sep}`) &&
        statSync(fullPath).isFile()
      );
    })
    .sort();
  const hashes = {};
  const aggregate = createHash("sha256");

  for (const path of files) {
    const content = readFileSync(resolve(root, path));
    const hash = createHash("sha256").update(content).digest("hex");
    hashes[path] = hash;
    aggregate.update(path).update("\0").update(hash).update("\0");
  }

  return { fingerprint: aggregate.digest("hex"), files: hashes };
}

export function repositoryState(
  root = REPO_ROOT,
  previous = null,
  certifySemantic = false,
) {
  return {
    schema: 2,
    code: sourceState(root, "code"),
    semantic: certifySemantic
      ? sourceState(root, "semantic")
      : previous?.schema === 2
        ? previous.semantic
        : null,
  };
}

function normalizeGraphifyMetadata() {
  const rootMarker = join(OUTPUT_DIR, ".graphify_root");
  if (existsSync(rootMarker)) writeFileSync(rootMarker, ".\n", "utf8");

  const manifestPath = join(OUTPUT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const normalized = {};
  for (const [path, metadata] of Object.entries(manifest)) {
    const absolute = resolve(path);
    const rel = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
    if (!rel.startsWith("../") && rel !== ".." && isRelevantSource(rel)) {
      normalized[rel] = metadata;
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
}

export function isSafeGraphSource(path, root = REPO_ROOT) {
  if (!path) return true;
  const normalized = String(path).replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return false;
  }
  return (
    isRelevantSource(normalized) &&
    resolve(root, normalized).startsWith(`${resolve(root)}${sep}`)
  );
}

function sanitizeGraph() {
  const graphPath = join(OUTPUT_DIR, "graph.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const nodes = graph.nodes.filter((node) =>
    isSafeGraphSource(node.source_file),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = graph.links.filter(
    (link) =>
      nodeIds.has(
        typeof link.source === "object" ? link.source.id : link.source,
      ) &&
      nodeIds.has(
        typeof link.target === "object" ? link.target.id : link.target,
      ) &&
      isSafeGraphSource(link.source_file),
  );
  const removed =
    graph.nodes.length - nodes.length + graph.links.length - links.length;
  graph.nodes = nodes;
  graph.links = links;
  if (Array.isArray(graph.hyperedges)) {
    graph.hyperedges = graph.hyperedges.filter((edge) =>
      isSafeGraphSource(edge.source_file),
    );
  }
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return removed;
}

function runGraphify(args, failureMessage) {
  const result = spawnSync("graphify", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, GRAPHIFY_NO_TIPS: "1" },
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "graphify is not installed. Install it with `pip install graphifyy`.",
    );
  }
  if (result.error || result.status !== 0) throw new Error(failureMessage);
}

function regenerateWiki() {
  const code = String.raw`
import json
from collections import defaultdict
from pathlib import Path
from networkx.readwrite import json_graph
from graphify.analyze import god_nodes
from graphify.wiki import to_wiki

data = json.loads(Path("graphify-out/graph.json").read_text(encoding="utf-8"))
try:
    graph = json_graph.node_link_graph(data, edges="links")
except TypeError:
    graph = json_graph.node_link_graph(data)
communities = defaultdict(list)
for node_id, attributes in graph.nodes(data=True):
    community = attributes.get("community")
    if community is not None:
        communities[int(community)].append(node_id)
to_wiki(graph, dict(communities), "graphify-out/wiki", god_nodes_data=god_nodes(graph))
`;
  const result = spawnSync("python3", ["-c", code], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Could not regenerate the wiki. Ensure Python, networkx, and graphifyy are installed.",
    );
  }
}

export function validateWiki(wikiDir = join(OUTPUT_DIR, "wiki")) {
  const errors = [];
  const indexPath = join(wikiDir, "index.md");
  if (!existsSync(indexPath)) return ["Missing graphify-out/wiki/index.md"];

  const index = readFileSync(indexPath, "utf8");
  const articles = readdirSync(wikiDir)
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort();
  const linked = new Set();
  const markdownLinks = /\[[^\]]*\]\(([^)]+\.md)(?:#[^)]+)?\)/g;
  const wikiLinks = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

  for (const match of index.matchAll(markdownLinks)) {
    const target = decodeURIComponent(match[1]).replace(/^\.\//, "");
    linked.add(target);
    if (!existsSync(join(wikiDir, target)))
      errors.push(`Index link is missing: ${target}`);
  }
  for (const match of index.matchAll(wikiLinks)) {
    const target = `${match[1].replaceAll(" ", "_")}.md`;
    linked.add(target);
    if (!existsSync(join(wikiDir, target)))
      errors.push(`Index link is missing: ${target}`);
  }
  for (const article of articles) {
    if (!linked.has(article))
      errors.push(`Wiki article is not indexed: ${article}`);
  }
  return errors;
}

function pruneUnindexedWikiArticles() {
  const prefix = "Wiki article is not indexed: ";
  for (const error of validateWiki(join(OUTPUT_DIR, "wiki"))) {
    if (error.startsWith(prefix)) {
      unlinkSync(join(OUTPUT_DIR, "wiki", error.slice(prefix.length)));
    }
  }
}

export function check(root = REPO_ROOT, warnings = []) {
  const errors = [];
  const required = [
    "graph.json",
    "GRAPH_REPORT.md",
    "wiki/index.md",
    ".repo-state.json",
  ];
  for (const path of required) {
    if (!existsSync(join(root, "graphify-out", path)))
      errors.push(`Missing graphify-out/${path}`);
  }
  if (errors.length) return errors;

  try {
    const graph = JSON.parse(
      readFileSync(join(root, "graphify-out/graph.json"), "utf8"),
    );
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
      errors.push(
        "graph.json must contain node-link arrays named nodes and links",
      );
    } else {
      const polluted = [...graph.nodes, ...graph.links]
        .map((item) => item.source_file)
        .filter((source) => source && !isSafeGraphSource(source, root));
      if (polluted.length) {
        errors.push(
          `graph.json contains excluded or unsafe sources (for example: ${polluted[0]})`,
        );
      }
    }
  } catch (error) {
    errors.push(`graph.json is invalid JSON: ${error.message}`);
  }

  try {
    const expected = JSON.parse(
      readFileSync(join(root, "graphify-out/.repo-state.json"), "utf8"),
    );
    const currentCode = sourceState(root, "code");
    const currentSemantic = sourceState(root, "semantic");
    if (
      expected.schema !== 2 ||
      expected.code?.fingerprint !== currentCode.fingerprint
    ) {
      errors.push(
        "Graph output is stale relative to code or graphify configuration",
      );
    }
    if (!expected.semantic) {
      warnings.push(
        "Semantic freshness is unverified. After a full semantic rebuild, run `pnpm graphify:generate -- --semantic-current`.",
      );
    } else if (expected.semantic.fingerprint !== currentSemantic.fingerprint) {
      errors.push(
        "Graph semantic content is stale relative to docs; run a full semantic rebuild, then `pnpm graphify:generate -- --semantic-current`",
      );
    }
  } catch (error) {
    errors.push(`Graph source state is invalid: ${error.message}`);
  }

  errors.push(...validateWiki(join(root, "graphify-out/wiki")));

  const machinePath = `${resolve(root)}${sep}`;
  for (const path of [
    ".graphify_root",
    "manifest.json",
    "graph.json",
    "GRAPH_REPORT.md",
  ]) {
    const fullPath = join(root, "graphify-out", path);
    if (
      existsSync(fullPath) &&
      readFileSync(fullPath, "utf8").includes(machinePath)
    ) {
      errors.push(`graphify-out/${path} contains an absolute repository path`);
    }
  }
  return errors;
}

function generate({ certifySemantic = false } = {}) {
  if (!existsSync(join(OUTPUT_DIR, "graph.json"))) {
    throw new Error(
      "No base graph exists. Run the documented full semantic rebuild once, then rerun this command.",
    );
  }
  runGraphify(["update", "."], "graphify update failed");

  const removed = sanitizeGraph();
  runGraphify(["cluster-only", "."], "graphify re-clustering failed");
  regenerateWiki();
  pruneUnindexedWikiArticles();
  normalizeGraphifyMetadata();
  let previousState = null;
  if (existsSync(STATE_PATH)) {
    try {
      previousState = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    } catch {
      // A corrupt or legacy state cannot certify semantic freshness.
    }
  }
  writeFileSync(
    STATE_PATH,
    `${JSON.stringify(repositoryState(REPO_ROOT, previousState, certifySemantic), null, 2)}\n`,
    "utf8",
  );
  const warnings = [];
  const errors = check(REPO_ROOT, warnings);
  if (errors.length) throw new Error(errors.join("\n"));
  for (const warning of warnings) console.warn(`graphify: warning: ${warning}`);
  console.log(
    `graphify code output generated and verified${removed ? `; removed ${removed} polluted graph entries` : ""}.`,
  );
}

function main() {
  const command = process.argv[2];
  try {
    if (command === "generate") {
      const unknown = process.argv
        .slice(3)
        .filter((arg) => arg !== "--" && arg !== "--semantic-current");
      if (unknown.length)
        throw new Error(`Unknown generate option: ${unknown.join(", ")}`);
      generate({
        certifySemantic: process.argv.includes("--semantic-current"),
      });
    } else if (command === "check") {
      const warnings = [];
      const errors = check(REPO_ROOT, warnings);
      if (errors.length) throw new Error(errors.join("\n"));
      for (const warning of warnings)
        console.warn(`graphify: warning: ${warning}`);
      console.log(
        warnings.length
          ? "graphify code output is current and structural artifacts are consistent."
          : "graphify output is current and consistent.",
      );
    } else {
      console.error(
        "Usage: node scripts/graphify.mjs generate [--semantic-current] | check",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`graphify: ${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
