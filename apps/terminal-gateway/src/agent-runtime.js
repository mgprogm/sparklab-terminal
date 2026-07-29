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
// iter3 SCOPE (D5): claude-cli, LOCAL sessions only, is now wired through the
// per-run MCP proxy (tools/agentic-proxy/server.mjs) — see the claude-cli
// builder + buildMcpPolicyManifest below. codex-cli is DELIBERATELY left
// unwired; see the rationale comment on the codex-cli provider entry. Remote
// (ssh) sessions get NO MCP config for EITHER provider — see isLocalServer.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Absolute path to the per-run MCP proxy this repo ships alongside
// tools/kanban-mcp, tools/pm-mcp. Resolved via import.meta.url (matches this
// repo's other `tools/`-relative resolution, e.g. kanban.js/pm.js's own
// __dirname pattern) so it is correct regardless of process.cwd().
const AGENTIC_PROXY_PATH = path.resolve(
  __dirname,
  "../../../tools/agentic-proxy/server.mjs",
);

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

// A session's target server is "local" when unset or explicitly type:"local"
// (matches registry.js's implicit `local` entry). Extracted to a named helper
// (iter3) because it now gates TWO independent things, for BOTH providers:
//   - agentChildEnv: whether the provider's own credential namespace is safe
//     to write to the target's disk (iter2 stance, unchanged);
//   - the claude-cli builder: whether the per-run MCP proxy is wired in at
//     all (iter3, D5) — a remote target gets NO MCP config, matching the
//     iter2 fail-closed posture now applied uniformly regardless of provider
//     (HARD CONSTRAINT #3: this repo's tools/ dir, and the proxy it runs,
//     likely doesn't exist on an arbitrary remote host).
function isLocalServer(server) {
  return !server || server.type === "local";
}

/**
 * Build the curated env for a provider child on `server`.
 * @param {object|null} server - registry server record (null/`local` = local).
 * @param {"codex-cli"|"claude-cli"} provider
 * @param {{azureHeaders?: object}} [opts] - codex-only Azure header passthrough.
 * @returns {Record<string,string>} env map (rendered into wrapper.sh exports).
 */
function agentChildEnv(server, provider, { azureHeaders } = {}) {
  const isLocal = isLocalServer(server);
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
 * @property {Record<string,{targetType:string}>} [connections] - iter3 (D5):
 *   frozen resolvedConfig.connections; used only by claude-cli/local to build
 *   the MCP policy manifest.
 * @property {string} [gatewayApiToken] - iter3 (D5): the gateway's own bearer
 *   (GATEWAY_API_TOKEN||KANBAN_API_TOKEN); reaches the proxy ONLY via its
 *   mcp.json env block, never via the manifest file (see the claude-cli
 *   builder + buildMcpPolicyManifest).
 * @property {string} [gatewayBaseUrl] - iter3 (D5): e.g. http://127.0.0.1:3007.
 * @property {string} [agentSessionId] - claude-cli conversation UUID
 * @property {boolean} [resume] - resume the claude-cli conversation
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
    // iter3 (D5): frozen resolvedConfig.connections ({connId:{targetType}})
    // + the gateway's own base URL/bearer, needed ONLY by the claude-cli/local
    // branch to build the MCP policy manifest + point --mcp-config at the
    // proxy. Optional/undefined is fine for codex-cli and for remote targets
    // (neither ever reads them).
    connections,
    gatewayApiToken,
    gatewayBaseUrl,
    agentSessionId,
    resume,
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
    connections,
    gatewayApiToken,
    gatewayBaseUrl,
    agentSessionId,
    resume,
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

// ---- Per-run MCP policy manifest (iter3, D5) --------------------------------
// Pure function of already-frozen data (D9): `connections` is the
// resolvedConfig.connections map ({connId: {targetType}}, frozen by
// server.js's startRun at run-start) and `agent.toolPolicies` is the agent's
// OWN frozen policy list (already part of the resolved agent snapshot — no
// new field needed there). No live store lookup happens here, so a connection
// deleted mid-run can never affect an in-flight node's manifest.
//
// Shape MUST match tools/agentic-proxy/server.mjs's documented contract
// byte-for-byte (connections[].{connectionId, targetType,
// toolPolicies[].{tools, policy}}, gatewayBaseUrl, runId, nodeId) — the proxy
// fails CLOSED on a shape mismatch (silently empty tools/list), not loudly.
// Deliberately absent: any gateway token. The token reaches the proxy only
// via its own MCP-launch env block (see the claude-cli builder below); this
// avoids duplicating a secret across both channels for no benefit.
function buildMcpPolicyManifest({
  connections,
  agent,
  runId,
  nodeId,
  gatewayBaseUrl,
}) {
  const conns = connections || {};
  const toolPolicies =
    agent && Array.isArray(agent.toolPolicies) ? agent.toolPolicies : [];
  const outConnections = Object.keys(conns).map((connectionId) => ({
    connectionId,
    targetType: conns[connectionId] && conns[connectionId].targetType,
    toolPolicies: toolPolicies
      .filter((p) => p.connectionId === connectionId)
      .map((p) => ({ tools: p.tools, policy: p.policy })),
  }));
  return {
    connections: outConnections,
    gatewayBaseUrl: gatewayBaseUrl || "",
    runId,
    nodeId,
  };
}

// Precondition (build spec §a): if the gateway has no bearer token configured
// (neither GATEWAY_API_TOKEN nor legacy KANBAN_API_TOKEN — server.js resolves
// that and passes the result as `gatewayApiToken`), the proxy's own children
// and its callback POSTs can't authenticate either. Degrade gracefully: build
// the manifest with ZERO connections (tools/list ends up empty — deny by
// omission) instead of spawning a guaranteed-broken proxy silently. Warn ONCE
// per process, not per node/run (this would otherwise spam on every spawn).
let warnedMissingGatewayToken = false;
function connectionsForManifest(connections, gatewayApiToken) {
  const conns = connections || {};
  if (!gatewayApiToken && Object.keys(conns).length > 0) {
    if (!warnedMissingGatewayToken) {
      console.warn(
        "[agent-runtime] GATEWAY_API_TOKEN/KANBAN_API_TOKEN is not configured — " +
          "agentic-run MCP connections will be unreachable (proxy manifest built " +
          "with zero connections; deny-by-omission, not a thrown error).",
      );
      warnedMissingGatewayToken = true;
    }
    return {};
  }
  return conns;
}

// ---- Provider registry -----------------------------------------------------
const PROVIDERS = {
  // codex exec -C <cwd> --sandbox <mode> --skip-git-repo-check --color never -
  // Prompt on STDIN (`-`), redirected from the 0600 prompt file. Verbatim form
  // of the working run_codex route.
  //
  // iter3 (D5) MCP-proxy wiring — DELIBERATELY NOT DONE for codex-cli. This is
  // the plan's explicitly pre-approved acceptable outcome, evaluated with a
  // real, bounded (one `timeout 30 codex exec ...` run, RUST_LOG=debug) live
  // check during this pass, not just reasoned about:
  //   1. `-c mcp_servers.<name>...=...` MERGES with the ambient
  //      ~/.codex/config.toml mcp_servers table, it does NOT replace it —
  //      confirmed live: a run with `-c mcp_servers.testproxy.command=...`
  //      still initialized BOTH the injected proxy AND the ambient
  //      `openaiDeveloperDocs` server in the same session
  //      (`mcp_servers="openaiDeveloperDocs, testproxy"`,
  //      `mcp_server_count=2` in the debug log). Wiring the proxy in via bare
  //      `-c` would therefore add a MEDIATED path ALONGSIDE whatever
  //      unmediated servers the ambient config already declares — it would
  //      not close the D5 fail-open this iteration exists to close, and would
  //      look like mediation was added when the real gap (ambient servers
  //      reachable unmediated) is untouched.
  //   2. `--ignore-user-config` DOES achieve exclusive scoping, but drops the
  //      ENTIRE config file — including `model`/`model_provider`/
  //      `model_providers.azure.*` — so the provider silently reverts to
  //      built-in `openai` (401) unless every one of those is replicated via
  //      more `-c` flags. The gateway doesn't own or track an operator's
  //      codex provider config, so this is fragile in a way specific to this
  //      deployment: a version bump or a different operator account could
  //      silently break auth or isolation with no local signal.
  //   3. Independent of both of the above, `codex exec`'s non-interactive
  //      harness cannot execute ANY MCP tool call without a `readOnlyHint:true`
  //      tool annotation (it raises an elicitation only an interactive TUI can
  //      answer, and auto-resolves it as Cancel) — a real fix would need the
  //      proxy's annotation-injection trick AND one of the two scoping
  //      mechanisms above, compounding the fragility rather than resolving it.
  // Net: codex-cli's invocation is UNCHANGED from iter2 for both local and
  // remote targets (ambient ~/.codex/config.toml MCP, already-reviewed
  // run_codex posture). Residual exposure is low-but-nonzero and specific to
  // whatever the ambient config on the target host happens to declare — not
  // something this iteration controls. Re-evaluate only if the deployment
  // model changes (e.g. a gateway-owned CODEX_HOME per run).
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
  // FAIL-CLOSED MCP ISOLATION (iter2, still the REMOTE posture in iter3):
  // claude -p otherwise performs AMBIENT MCP discovery from ~/.claude.json /
  // project scope. Because a run executes in the target session's cwd, an
  // unhardened claude-cli agent would silently inherit whatever MCP servers
  // that cwd is scoped to (e.g. this repo's own pm/kanban), UNMEDIATED —
  // violating D5. We always pass --strict-mcp-config ("only use servers from
  // --mcp-config, ignore all other MCP config") so ambient discovery is
  // NEVER reachable, on local OR remote.
  //
  // iter3 (D5) LOCAL branch: --mcp-config now points at a real MCP server
  // entry that spawns the per-run proxy (tools/agentic-proxy/server.mjs) —
  // the CLI's OWN mcp.json is the launch mechanism that hands the proxy its
  // env (gateway bearer + base URL + run/node ids + the manifest file path).
  // `--allowedTools mcp__agentic-proxy` is REQUIRED alongside this — verified
  // live: without it, claude -p flatly denies every MCP call ("...but you
  // haven't granted it yet"), and under --permission-mode plan specifically
  // a tool call is additionally blocked unless the proxy's tools/list tagged
  // it readOnlyHint:true (which it always does — see the proxy's own header
  // comment; this governs the CLI's local harness gate, not the proxy's real
  // allow/deny/approval enforcement, which is unaffected).
  //
  // iter3 REMOTE branch (HARD CONSTRAINT #3): byte-identical to iter2 — an
  // empty --mcp-config, NO --allowedTools flag. This repo's tools/ dir (and
  // the proxy script it would need to spawn) likely doesn't exist on an
  // arbitrary remote host, and per-run MCP-proxy distribution to remote hosts
  // is explicitly out of iter3 scope. Applies to EITHER provider uniformly —
  // codex-cli never wires MCP in the first place (see its own comment above),
  // so this branch only has visible effect for claude-cli, but the gate
  // itself (isLocalServer) is provider-agnostic by construction.
  "claude-cli": {
    build(_input, ctx) {
      if (ctx.resume && !ctx.agentSessionId)
        throw new Error("agentSessionId is required to resume claude-cli");
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

      const isLocal = isLocalServer(ctx.server);
      let extraFiles;
      let allowedToolsFlag = "";
      if (isLocal) {
        const proxyServerName = "agentic-proxy"; // fixed — claude namespaces
        // tools as mcp__agentic-proxy__<tool>; --allowedTools below must match.
        const policyPath = path.posix.join(ctx.scratchDir, "mcp-policy.json");
        const manifest = buildMcpPolicyManifest({
          connections: connectionsForManifest(
            ctx.connections,
            ctx.gatewayApiToken,
          ),
          agent: ctx.agent,
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          gatewayBaseUrl: ctx.gatewayBaseUrl,
        });
        const mcpConfig = {
          mcpServers: {
            [proxyServerName]: {
              command: "node",
              args: [AGENTIC_PROXY_PATH],
              env: {
                // ONLY here, never in the manifest file (see
                // buildMcpPolicyManifest's own comment) — this is the CLI's
                // own MCP-server-launch env block, the intended channel per
                // the proxy's documented wire contract.
                GATEWAY_API_TOKEN: ctx.gatewayApiToken || "",
                GATEWAY_BASE_URL: ctx.gatewayBaseUrl || "",
                AGENTIC_RUN_ID: ctx.runId,
                AGENTIC_NODE_ID: ctx.nodeId,
                AGENTIC_POLICY_FILE: policyPath,
              },
            },
          },
        };
        extraFiles = [
          {
            relPath: "mcp-policy.json",
            mode: "600",
            content: `${JSON.stringify(manifest, null, 2)}\n`,
          },
          {
            relPath: "mcp.json",
            mode: "600",
            content: `${JSON.stringify(mcpConfig, null, 2)}\n`,
          },
        ];
        allowedToolsFlag = `--allowedTools ${shSingleQuote(`mcp__${proxyServerName}`)} `;
      } else {
        // Remote: empty MCP config, byte-identical to iter2. NO --allowedTools.
        extraFiles = [
          { relPath: "mcp.json", mode: "600", content: '{"mcpServers":{}}\n' },
        ];
      }

      const sessionFlag = ctx.resume
        ? `--resume ${shSingleQuote(ctx.agentSessionId)} `
        : ctx.agentSessionId
          ? `--session-id ${shSingleQuote(ctx.agentSessionId)} `
          : "";

      const invocationLine =
        `cat ${promptPath} | ${cmd} -p ` +
        sessionFlag +
        `--output-format stream-json --verbose ` +
        `--permission-mode ${shSingleQuote(permissionMode)} ` +
        `--append-system-prompt-file ${systemPath} ` +
        `--mcp-config ${mcpPath} --strict-mcp-config ` +
        `${allowedToolsFlag}` +
        `> ${outLog} 2>&1`;
      return assembleInvocation(ctx, {
        invocationLine,
        sandboxMode,
        extraFiles,
      });
    },
  },
};

/**
 * Map a finished node's exit code → a terminal nodeExecution status. iter2 does
 * NOT parse stream-json semantically: exit 0 → done, non-zero → failed. Router
 * branch labels are read from the last plain-text `BRANCH: <label>` line.
 * @param {string} logTail
 * @param {number|null} exitCode
 * @returns {{status:"done"|"failed", branch:string|null}}
 */
function parseResult(logTail, exitCode) {
  let branch = null;
  for (const match of String(logTail || "").matchAll(
    /^\s*BRANCH:\s*(\S+)\s*$/gim,
  )) {
    branch = match[1];
  }
  return { status: Number(exitCode) === 0 ? "done" : "failed", branch };
}

export default {
  buildInvocation,
  parseResult,
  agentChildEnv,
  isLocalServer,
  buildMcpPolicyManifest,
  // Exposed for server.js caps + tests.
  CODEX_COMMAND,
  CLAUDE_COMMAND,
  AGENT_PROMPT_MAX_BYTES,
  AGENT_OUTPUT_MAX_BYTES,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  SANDBOX_MODES,
  AGENTIC_PROXY_PATH,
};
