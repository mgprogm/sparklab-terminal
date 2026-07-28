// AgentRuntimeProvider seam for the Agentic AI Creator run engine (iter2).
//
// This module is the PROVIDER abstraction (D6): given a resolved agent-task, it
// builds a self-contained tmux "wrapper invocation" — the set of files to write
// on the TARGET server plus the single command tmux runs. Two providers ship in
// iter2: `codex-cli` and `claude-cli`. It reuses the run_codex security template
// VERBATIM (server.js POST /api/sessions/:id/codex):
//   - the prompt is written to a 0600 file and fed via STDIN — NEVER on argv/the
//     tmux command line (so it is never shell-split nor visible in `ps`);
//   - the child env is a CURATED ALLOWLIST — never the gateway's full process.env
//     (no auth password/hash, no VAPID keys, no GATEWAY_API_TOKEN/KANBAN_API_TOKEN),
//     plus only the provider's OWN credential namespace, and ONLY when the target
//     server is local (a secret is never written to a remote disk — see below);
//   - the sandbox mode is code-clamped to read-only | workspace-write.
//
// HARD BOUNDARY: this file imports NOTHING from server.js or agentic.js. The
// dependency is one-way (server.js → agent-runtime.js): server.js owns the async
// tmux/marker I/O and calls buildInvocation() to get the files + command. Keeping
// it import-free also keeps agentic.js a pure sync store (constraint #3).
//
// iter2 SCOPE: providers just run the CLI in the target session's cwd. NO MCP
// servers are wired to the run yet (that per-run proxy is iter3), so an agent's
// toolPolicies/connections do not affect the invocation here.

import path from "node:path";

// ---- Command resolution (mirror server.js CODEX_COMMAND exactly) -----------
// JSON-array (e.g. ["codex","--foo"]) or a plain binary path; falls back to the
// default so a bare install just works. Tests point these at a stub script.
function parseCommand(rawEnv, fallback) {
  const raw = (rawEnv || "").trim();
  if (!raw) return [...fallback];
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (
        Array.isArray(arr) &&
        arr.length > 0 &&
        arr.every((x) => typeof x === "string")
      ) {
        return arr;
      }
    } catch {
      /* fall through to treating raw as a plain path */
    }
  }
  return [raw];
}

const CODEX_COMMAND = parseCommand(process.env.CODEX_COMMAND, ["codex"]);
const CLAUDE_COMMAND = parseCommand(process.env.CLAUDE_COMMAND, ["claude"]);

// ---- Sandbox / permission constants ----------------------------------------
const SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
// claude has no --sandbox flag; it uses --permission-mode. iter2 maps
// read-only → plan and workspace-write → acceptEdits and REFUSES anything else
// (the CLI also accepts auto/bypassPermissions/manual/dontAsk — none are
// reachable through this builder).
const CLAUDE_PERMISSION_MODES = new Set(["plan", "acceptEdits"]);
// Override/cap/safety-floor for the read-only tier (verified allowed value).
const CLAUDE_DEFAULT_PERMISSION_MODE =
  (process.env.CLAUDE_DEFAULT_PERMISSION_MODE || "plan").trim() || "plan";

// ---- Byte caps (shared names with server.js; the run engine reads AGENT_*) --
const AGENT_PROMPT_MAX_BYTES =
  Number(process.env.AGENT_PROMPT_MAX_BYTES) || 16 * 1024;
const AGENT_OUTPUT_MAX_BYTES =
  Number(process.env.AGENT_OUTPUT_MAX_BYTES) || 128 * 1024;

// ---- Curated env allowlist (KEEP IN SYNC with server.js CODEX_ENV_ALLOWLIST) -
// Base = non-secret vars any CLI needs to run. Per-provider we additionally pass
// the provider's OWN credential namespace — but ONLY for a local target. This is
// the exact stance of codexChildEnv(): a secret is never written to a remote
// disk (here it would land in the wrapper.sh on the target host), so the remote
// host must use its own `codex`/`claude` login. VAPID / auth-hash /
// GATEWAY_API_TOKEN / KANBAN_API_TOKEN are NEVER in the allowlist or the prefixes,
// so they can never leak into a wrapper.
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
];
// Provider credential namespaces (local target only).
const PROVIDER_CRED_PREFIX = {
  "codex-cli": /^(CODEX_|OPENAI_)/,
  "claude-cli": /^(ANTHROPIC_|CLAUDE_)/,
};
// Codex may also reuse agent-service's Azure config, injected as request headers
// (exactly as run_codex does). Local target only.
const CODEX_AZURE_HEADERS = {
  "x-sparklab-codex-azure-endpoint": "AZURE_OPENAI_ENDPOINT",
  "x-sparklab-codex-azure-api-key": "AZURE_OPENAI_API_KEY",
  "x-sparklab-codex-azure-api-version": "AZURE_OPENAI_API_VERSION",
  "x-sparklab-codex-azure-deployment": "GPT56SOL_DEPLOYMENT",
};

/**
 * Build the curated env for a provider child on `server`.
 * @param {object|null} server - registry server record (null/`local` = local).
 * @param {"codex-cli"|"claude-cli"} provider
 * @param {{azureHeaders?: object}} [opts] - codex-only Azure header passthrough.
 * @returns {Record<string,string>} env map (rendered into wrapper.sh exports).
 */
function agentChildEnv(server, provider, { azureHeaders } = {}) {
  const isLocal = !server || server.type === "local";
  const env = {};
  for (const k of BASE_ENV_ALLOWLIST) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  if (isLocal) {
    // Local: include the provider's OWN credential namespace (its API key/login).
    const prefix = PROVIDER_CRED_PREFIX[provider];
    if (prefix) {
      for (const k of Object.keys(process.env)) {
        if (prefix.test(k)) env[k] = process.env[k];
      }
    }
    if (provider === "codex-cli" && azureHeaders) {
      for (const [header, envName] of Object.entries(CODEX_AZURE_HEADERS)) {
        const v = azureHeaders[header];
        if (typeof v === "string" && v.trim()) env[envName] = v;
      }
    }
  }
  // Remote (ssh): base allowlist only — the remote host uses its own login. The
  // gateway never writes its secrets to a remote disk (identical to run_codex).
  return env;
}

// ---- Shell quoting (local copy; must NOT import from server.js) ------------
// POSIX single-quote for embedding a literal into the wrapper's shell text.
function shSingleQuote(arg) {
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

// Render the curated env as one `export K=V` per line (values single-quoted).
function renderEnvExports(env) {
  return Object.keys(env)
    .map((k) => `export ${k}=${shSingleQuote(env[k])}`)
    .join("\n");
}

// Clamp/re-assert the sandbox mode (never reachable to danger-full-access).
function clampSandbox(mode) {
  if (!SANDBOX_MODES.has(mode))
    throw new Error(
      `invalid sandboxMode: ${mode} (must be read-only|workspace-write)`,
    );
  return mode;
}

// Map an agent sandboxMode → a claude --permission-mode. read-only is governed
// by CLAUDE_DEFAULT_PERMISSION_MODE (override/cap/floor); workspace-write →
// acceptEdits. The result must be in the iter2 allowlist {plan, acceptEdits}.
function claudePermissionMode(sandboxMode) {
  clampSandbox(sandboxMode);
  const mode =
    sandboxMode === "workspace-write"
      ? "acceptEdits"
      : CLAUDE_DEFAULT_PERMISSION_MODE;
  if (!CLAUDE_PERMISSION_MODES.has(mode))
    throw new Error(
      `invalid claude permission-mode: ${mode} (iter2 allows plan|acceptEdits)`,
    );
  return mode;
}

// The wrapper.sh body, identical across providers except the invocation line.
// Two-marker scheme (restart-safety, server.js reap table):
//   - start.marker is touched BEFORE the provider runs;
//   - exit.marker is written tmp+rename (atomic) so a half-written marker is
//     never read; a crash after marker-write is safe (the file persists).
function wrapperScript({ envExports, cwd, scratchDir, invocationLine }) {
  const sd = shSingleQuote(scratchDir);
  const startMarker = shSingleQuote(
    path.posix.join(scratchDir, "start.marker"),
  );
  const exitMarker = shSingleQuote(path.posix.join(scratchDir, "exit.marker"));
  const exitTmp = shSingleQuote(path.posix.join(scratchDir, "exit.marker.tmp"));
  return [
    "#!/usr/bin/env bash",
    envExports,
    `mkdir -p ${sd}`,
    `: > ${startMarker}`,
    `cd ${shSingleQuote(cwd)} || { printf '%s' 127 > ${exitMarker}; exit 127; }`,
    invocationLine,
    "ec=$?",
    `printf '%s' "$ec" > ${exitTmp} && mv ${exitTmp} ${exitMarker}`,
    "",
  ].join("\n");
}

/**
 * @typedef {object} AgentTaskInput
 * @property {string} runId
 * @property {string} nodeId
 * @property {object} agent       - resolved Agent (systemPrompt, sandboxMode, runtimeProvider)
 * @property {string} cwd         - absolute path on the target server
 * @property {string} promptText  - objectiveTemplate + objective (no threading, iter2)
 * @property {string} scratchDir  - absolute AGENT_RUNS_DIR/<runId>/<nodeId> on the TARGET server
 * @property {object|null} server - registry server record (local | ssh)
 * @property {object} [azureHeaders] - codex-only Azure passthrough headers
 */

/**
 * @typedef {object} WrapperInvocation
 * @property {string} sessionName  - "agrun-<runId>-<nodeId>" (NEVER "web-")
 * @property {Array<{relPath:string,content:string,mode:string}>} files
 * @property {string} tmuxArg      - the single command tmux new-session runs
 * @property {string} provider
 * @property {string} sandboxMode
 */

// Compose the on-disk prompt/system content per provider (iter2: static only —
// NO inter-node data threading; every node runs the objective independently).
//   codex : systemPrompt is PREPENDED into the prompt file (codex has no
//           system-prompt flag); no system file.
//   claude: prompt file = objectiveTemplate+objective; system file = systemPrompt
//           (delivered via --append-system-prompt-file).
function composePrompt(provider, agent, promptText) {
  const systemPrompt =
    typeof agent.systemPrompt === "string" ? agent.systemPrompt : "";
  if (provider === "codex-cli") {
    const promptFile = systemPrompt
      ? `${systemPrompt}\n\n${promptText}`
      : promptText;
    return { promptFile, systemFile: null };
  }
  return { promptFile: promptText, systemFile: systemPrompt };
}

/**
 * Build the tmux wrapper invocation for one resolved agent-task node.
 * @param {AgentTaskInput} input
 * @returns {WrapperInvocation}
 */
function buildInvocation(input) {
  const {
    runId,
    nodeId,
    agent,
    cwd,
    promptText,
    scratchDir,
    server,
    azureHeaders,
  } = input;

  const provider = agent && agent.runtimeProvider;
  if (!PROVIDERS[provider])
    throw new Error(`unknown runtimeProvider: ${provider}`);
  if (typeof cwd !== "string" || !cwd.startsWith("/"))
    throw new Error(`cwd must be an absolute path (got: ${cwd})`);
  if (typeof scratchDir !== "string" || !scratchDir.startsWith("/"))
    throw new Error(`scratchDir must be an absolute path (got: ${scratchDir})`);

  // Enforce the prompt byte cap BEFORE building anything (reject over-long).
  const promptBytes = Buffer.byteLength(String(promptText || ""), "utf8");
  if (promptBytes > AGENT_PROMPT_MAX_BYTES)
    throw new Error(
      `prompt exceeds ${AGENT_PROMPT_MAX_BYTES} bytes (got ${promptBytes})`,
    );

  return PROVIDERS[provider].build(input, {
    provider,
    runId,
    nodeId,
    agent,
    cwd,
    promptText,
    scratchDir,
    server,
    azureHeaders,
  });
}

// Shared assembler: turns a per-provider invocation line + prompt/system content
// into the full WrapperInvocation (files + tmuxArg + sessionName). `extraFiles`
// lets a provider drop additional 0600 sidecar files into the scratch dir (e.g.
// claude's empty --mcp-config; see the claude-cli builder).
function assembleInvocation(ctx, { invocationLine, sandboxMode, extraFiles }) {
  const {
    provider,
    runId,
    nodeId,
    agent,
    cwd,
    promptText,
    scratchDir,
    server,
  } = ctx;
  const sessionName = `agrun-${runId}-${nodeId}`; // HARD-1: never "web-"
  const env = agentChildEnv(server, provider, {
    azureHeaders: ctx.azureHeaders,
  });
  const { promptFile, systemFile } = composePrompt(provider, agent, promptText);

  const files = [
    {
      relPath: "wrapper.sh",
      mode: "600",
      content: wrapperScript({
        envExports: renderEnvExports(env),
        cwd,
        scratchDir,
        invocationLine,
      }),
    },
    { relPath: "prompt", mode: "600", content: promptFile },
  ];
  if (systemFile != null)
    files.push({ relPath: "system", mode: "600", content: systemFile });
  if (Array.isArray(extraFiles)) for (const f of extraFiles) files.push(f);

  return {
    sessionName,
    files,
    // The ONLY thing on the tmux/ssh command line: run the wrapper. The prompt,
    // system prompt, and secrets all live inside 0600 files it reads.
    tmuxArg: `bash ${shSingleQuote(path.posix.join(scratchDir, "wrapper.sh"))}`,
    provider,
    sandboxMode,
  };
}

// ---- Provider registry -----------------------------------------------------
const PROVIDERS = {
  // codex exec -C <cwd> --sandbox <mode> --skip-git-repo-check --color never -
  // Prompt on STDIN (`-`), redirected from the 0600 prompt file. Verbatim form
  // of the working run_codex route.
  "codex-cli": {
    build(_input, ctx) {
      const sandboxMode = clampSandbox(ctx.agent.sandboxMode);
      const cmd = CODEX_COMMAND.map(shSingleQuote).join(" ");
      const promptPath = shSingleQuote(
        path.posix.join(ctx.scratchDir, "prompt"),
      );
      const outLog = shSingleQuote(path.posix.join(ctx.scratchDir, "out.log"));
      const invocationLine =
        `${cmd} exec -C ${shSingleQuote(ctx.cwd)} ` +
        `--sandbox ${shSingleQuote(sandboxMode)} ` +
        `--skip-git-repo-check --color never - < ${promptPath} ` +
        `> ${outLog} 2>&1`;
      return assembleInvocation(ctx, { invocationLine, sandboxMode });
    },
  },

  // cat <prompt> | claude -p --output-format stream-json --verbose \
  //   --permission-mode <MODE> --append-system-prompt-file <system> \
  //   --mcp-config <empty> --strict-mcp-config
  // Prompt on STDIN (verified), system via --append-system-prompt-file
  // (verified) — nothing sensitive on argv. stream-json REQUIRES --verbose in
  // -p mode (verified CLI constraint).
  //
  // FAIL-CLOSED MCP ISOLATION (iter2): claude -p otherwise performs AMBIENT MCP
  // discovery from ~/.claude.json / project scope. Because a run executes in the
  // target session's cwd, an unhardened claude-cli agent would silently inherit
  // whatever MCP servers that cwd is scoped to (e.g. this repo's own pm/kanban),
  // UNMEDIATED — violating D5 before the iter3 proxy even exists. We pin an EMPTY
  // per-run --mcp-config and pass --strict-mcp-config ("only use servers from
  // --mcp-config, ignore all other MCP config"), so an iter2 run reaches ZERO MCP
  // servers. iter3 swaps the empty file for one pointing at the per-run proxy.
  // (Codex's ambient ~/.codex/config.toml MCP is the pre-existing, already-reviewed
  // run_codex template posture and is intentionally left as-is until iter3.)
  "claude-cli": {
    build(_input, ctx) {
      const sandboxMode = clampSandbox(ctx.agent.sandboxMode);
      const permissionMode = claudePermissionMode(sandboxMode);
      const cmd = CLAUDE_COMMAND.map(shSingleQuote).join(" ");
      const promptPath = shSingleQuote(
        path.posix.join(ctx.scratchDir, "prompt"),
      );
      const systemPath = shSingleQuote(
        path.posix.join(ctx.scratchDir, "system"),
      );
      const mcpPath = shSingleQuote(
        path.posix.join(ctx.scratchDir, "mcp.json"),
      );
      const outLog = shSingleQuote(path.posix.join(ctx.scratchDir, "out.log"));
      const invocationLine =
        `cat ${promptPath} | ${cmd} -p ` +
        `--output-format stream-json --verbose ` +
        `--permission-mode ${shSingleQuote(permissionMode)} ` +
        `--append-system-prompt-file ${systemPath} ` +
        `--mcp-config ${mcpPath} --strict-mcp-config ` +
        `> ${outLog} 2>&1`;
      return assembleInvocation(ctx, {
        invocationLine,
        sandboxMode,
        // Empty MCP config: with --strict-mcp-config this yields zero MCP servers.
        extraFiles: [
          { relPath: "mcp.json", mode: "600", content: '{"mcpServers":{}}\n' },
        ],
      });
    },
  },
};

/**
 * Map a finished node's exit code → a terminal nodeExecution status. iter2 does
 * NOT parse stream-json semantically: exit 0 → done, non-zero → failed. logTail
 * is display-only (accepted for the D6 interface; unused for the verdict).
 * @param {string} _logTail
 * @param {number|null} exitCode
 * @returns {{status:"done"|"failed"}}
 */
function parseResult(_logTail, exitCode) {
  return { status: Number(exitCode) === 0 ? "done" : "failed" };
}

export default {
  buildInvocation,
  parseResult,
  agentChildEnv,
  // Exposed for server.js caps + tests.
  CODEX_COMMAND,
  CLAUDE_COMMAND,
  AGENT_PROMPT_MAX_BYTES,
  AGENT_OUTPUT_MAX_BYTES,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  SANDBOX_MODES,
};
