# OpenRouter dynamic model search & switching — Design & Implementation Plan

> Status: **implemented** (2026-09-05, Task Master Hub task 3, all 6
> subtasks). Every decision below shipped as written — no deviations. Summary:
> `AgentModelSchema` stayed closed (§2); a new optional `openrouterModelId`
> field + a dedicated `openrouter_models_request`/`_response` WS frame pair
> deliver the live catalog (§3); `resolveModel()` validates any requested id
> against the fetched catalog before it can reach the upstream request (§2);
> a `reasoning.mandatory` model's `"none"` effort is transparently upgraded to
> its `defaultEffort` (§4, an addition discovered necessary during 3.3 — the
> catalog reduction now also carries `defaultEffort`, not just
> `supportedEfforts`/`mandatory` as originally sketched); the composer's
> search row (§5) is live-verified against the real OpenRouter API, including
> a real completed turn against a free model
> (`nvidia/nemotron-3.5-lightning:free`) that returned the exact expected
> reply. 590 tests pass across all three tiers (shared-types 54, agent-service
> 198, terminal 338) — see the "`openrouter-gpt-latest`" section of
> [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md) for the shipped operator-facing
> reference. Original design record follows, unedited below this banner.
>
> Extends the already-shipped fixed-allowlist OpenRouter provider
> (`openrouter-gpt-latest`) with a live, searchable catalog instead of one
> hardcoded upstream id. Task Master Hub task 1 recorded "no dynamic catalog
> fetching" as an explicit non-goal (subtask 1.1) — §7 below is the explicit
> record of why that non-goal is being reversed here.

**Scope**: the user can open the model picker, search OpenRouter's live model
catalog by name/id, and pick **any** model OpenRouter currently serves for
that turn — not just the one id configured in `.env`. Reasoning-effort options
shown in the composer become per-model (derived from the catalog), not the
current fixed enum-wide toggle. Confirmed direction (2026-09-05): **fully
open catalog** (any listed OpenRouter model, not an admin-curated subset) and
**live API-backed** (agent-service queries OpenRouter's own `/models`
endpoint, not a hand-maintained list).

---

## 0. Grounding (verified against source, this session)

- `AgentModelSchema` (`packages/shared-types/src/agent.ts:88`) is a **closed**
  `z.enum([...])`. `AgentCapabilitiesSchema.models` (`agent.ts:246`) is
  `z.array(AgentModelSchema).min(1)`, sent once per WS connection in one
  `agent_capabilities` frame (`index.ts:296`) built from `availableModels()`
  (`azure.ts`).
- The composer (`composer.tsx`) keys three `Record<AgentModel, ...>` maps —
  `MODEL_LABELS`, `MODEL_PROVIDER`, and the `modelSupportsEffort()` predicate —
  **exhaustively** over the closed enum. Any change here must not require
  these to become partial/unsafe.
- `resolveModel()` (`azure.ts`) already builds one `openrouter` client lazily
  when `config.openrouter.apiKey` is set, and returns
  `{ client, deployment, supportsReasoningEffort, extraBody }` — `deployment`
  is the exact string sent as `model` in the request body. Nothing else in
  `agent-loop.ts` inspects provider identity (verified in task 1.4 with a
  mocked-SSE test) — this is the seam a per-turn dynamic id plugs into.
- `agent-service`'s plain `http.createServer` (`index.ts:32`) currently
  serves only `/health`, `/ready`, `/`, and upgrades WS at `/agent` and
  `/browser-handoff` — there is no other REST surface, and no framework.
- OpenRouter's public `GET https://openrouter.ai/api/v1/models` (no auth
  required to list) returns `{ data: [...] }`; verified field shape this
  session:
  ```jsonc
  {
    "id": "openai/gpt-6-astra", // the exact model id to send
    "name": "OpenAI: GPT-6 Astra",
    "context_length": 1050000,
    "pricing": { "prompt": "0.00001", "completion": "0.00005" }, // per-token, string
    "supported_parameters": ["include_reasoning", "max_tokens", "..."],
    "reasoning": {
      // ABSENT on non-reasoning models
      "mandatory": true,
      "supported_efforts": ["max", "xhigh", "high", "medium", "low"],
      "default_effort": "medium",
    },
  }
  ```
  `reasoning.supported_efforts` uses the **same vocabulary** as
  `AgentReasoningEffortSchema` (`none|low|medium|high|xhigh|max` — OpenRouter
  omits `none` since a model either supports reasoning or the field is
  absent). This is a real, non-coincidental alignment worth relying on
  directly rather than inventing a separate mapping.
- **Threat model context**: this app is single-user (`GATEWAY_AUTH_USER` +
  one password hash, per root `CLAUDE.md`), and the `OPENROUTER_API_KEY` is
  that one user's own key. "Any model reachable" therefore collapses to "the
  key's owner can reach any model with their own money" — there is no second
  party whose cost/exposure this would change. This is why the fully-open
  catalog is a reasonable choice here where it would not be in a multi-tenant
  deployment.

---

## 1. Non-goal reversal (why subtask 1.1's "no dynamic catalog" is superseded)

Subtask 1.1 fixed one allowlisted id specifically to keep the wire schema
closed and avoid arbitrary-model exposure with no server-side gate. That
reasoning held for a **multi-tenant-shaped** worry (any chat user reaching
any priced model). It does not hold here: single-user auth means the
"multiple parties" premise was never true for this deployment. The
superseding decision is: **the catalog can be fully open, but the wire
protocol must still validate the chosen id server-side against a real,
freshly-fetched catalog** — never trust an arbitrary client-supplied string
verbatim into the upstream request body. That keeps "server capabilities are
the source of truth" intact even though the capability set is now dynamic.

## 2. Schema shape (the load-bearing decision)

**Keep `AgentModelSchema` closed.** Do not widen it to an open string union —
that would break every exhaustive `Record<AgentModel, ...>` in the composer
and lose the enum's compile-time exhaustiveness checks for the _native_
models (Azure/Ark/Codex CLI), which are not going anywhere.

Instead, repurpose the existing `openrouter-gpt-latest` enum member as the
**"OpenRouter provider slot"** and add one new optional companion field to
`AgentUserMessageSchema`:

```ts
export const AgentUserMessageSchema = z.object({
  type: z.literal("user_message"),
  text: z.string(),
  activeSessionId: z.string().optional(),
  model: AgentModelSchema.optional(),
  reasoningEffort: AgentReasoningEffortSchema.optional(),
  // NEW: only meaningful when model === "openrouter-gpt-latest". Selects a
  // specific catalog entry for this turn; omitted => config.openrouter.model
  // (today's fixed default). Validated server-side against the cached
  // catalog before use — never interpolated into the request unchecked.
  openrouterModelId: z.string().min(1).max(200).optional(),
});
```

- `openrouter-gpt-latest` **stays** the wire id (backward-compatible with
  every already-persisted chat message — `history.ts` replays these verbatim,
  so silently renaming or removing the id would corrupt old transcripts, per
  advisor review). Read as "route this turn through OpenRouter"; which
  specific upstream model is a per-turn parameter, not a new enum member.
- `resolveModel("openrouter-gpt-latest")` keeps its current signature but
  gains an optional second parameter for the requested catalog id; when
  provided and valid, `deployment` becomes that id instead of
  `config.openrouter.model`. When invalid (server-side catalog miss), return
  `undefined` — surfaces the existing "model not configured" `error` frame
  rather than forwarding a bad id to OpenRouter.
- Composer-side: `MODEL_LABELS["openrouter-gpt-latest"]` becomes the **label
  for the picker's OpenRouter row and search entry point**, not a fixed model
  name — the actual selected catalog model's display name renders next to it
  once chosen (see §5). `MODEL_PROVIDER`/`modelSupportsEffort` stay exhaustive
  and unchanged in shape; `modelSupportsEffort("openrouter-gpt-latest")`
  becomes conditionally true only once a specific catalog model with
  `reasoning.supported_efforts` is selected (tracked in local/store state, not
  the closed enum).

## 3. Catalog fetch, cache, and delivery channel

- **Fetch**: agent-service adds `src/openrouter-catalog.ts` — one `fetch()`
  to `${config.openrouter.baseUrl}/models` (no key required per OpenRouter,
  but send the configured `Authorization` anyway for consistency and any
  future gating), parsed and reduced to only the fields the frontend needs
  (`id`, `name`, `context_length`, `pricing.prompt`/`pricing.completion`,
  `reasoning.supported_efforts` when present). Never forward the full raw
  response (unbounded size, unvetted fields).
- **Cache**: in-memory, TTL default 10 minutes (`OPENROUTER_CATALOG_TTL_MS`,
  overridable), refreshed lazily on the next request past the TTL. **Serve
  stale data on a refetch failure** rather than blocking or erroring — a
  transient OpenRouter outage must not break the picker for models the user
  already knows about. An empty/never-fetched cache on first use fetches
  synchronously once (bounded timeout, e.g. 5s) before replying.
- **Delivery channel — decision: a new WS request/response frame pair, not a
  REST endpoint.** `agent_capabilities` already proved a catalog of hundreds
  of entries doesn't belong in the once-per-connect push frame (D-avoided:
  bloats every connect, most sessions never open the OpenRouter picker). A
  REST endpoint would need its own auth story duplicating the WS upgrade's
  origin+cookie check; reusing the existing authenticated `/agent` socket
  avoids a second surface entirely:
  - Client → server: `{ type: "openrouter_models_request" }` (no payload —
    search/filter happens client-side over the full cached list, per §5).
  - Server → client: `{ type: "openrouter_models_response", models: [...],
fetchedAt: <epoch ms> }`. Sent once per request, not streamed.
  - Requires `OPENROUTER_API_KEY` configured; otherwise reply with an empty
    list (the picker's search entry point itself is hidden per §5 when the
    provider isn't configured at all — mirrors the existing "hidden unless
    configured" rule for the whole `openrouter-gpt-latest` slot).

## 4. Reasoning effort becomes per-model

- On selecting a catalog model with a `reasoning.supported_efforts` array,
  the composer's reasoning-effort menu is filtered to **that model's**
  supported subset (mapped 1:1 onto `AgentReasoningEffortSchema` — no new
  values needed, confirmed vocabulary match in §0). A model with no
  `reasoning` field hides the effort control entirely, exactly like today's
  `-byteplus`/`codex-cli` treatment.
- Server-side, `resolveModel()`'s `supportsReasoningEffort` becomes
  `true` only when the selected catalog entry actually supports it — do not
  send `reasoning_effort` to a model that will reject or ignore it.
- `reasoning.mandatory: true` (some models require _some_ reasoning effort,
  not "none") is surfaced to the picker as: don't offer `none` as a choice
  for that model even if the schema-wide enum has it.

## 5. Frontend: search UI

- The picker's existing "Model" list keeps every native entry
  (Sol/Terra/Luna/Ark/Codex CLI) unchanged. Add one more row, **"OpenRouter
  (search…)"**, shown only when `openrouter-gpt-latest` is in
  `availableModels` (i.e., the provider is configured at all — unchanged
  gate). Selecting it opens a lightweight search input + filtered list (client
  side substring/fuzzy match over `id`/`name`) sourced from the cached catalog
  fetched via §3's WS round trip (fetched lazily on first open of this row,
  not on every composer render).
- Each result row shows: display name, `id` (monospace, for disambiguation —
  many providers ship near-identical names), and a compact price hint (e.g.
  `$0.01/$0.05 per 1K` derived from the per-token `pricing` strings — an
  explicit **in-scope** decision per the earlier open question, since cost
  visibility matters precisely because the catalog is fully open).
- Selecting a result sets local composer state
  `{ model: "openrouter-gpt-latest", openrouterModelId, label, reasoningEfforts }`
  and persists just enough (`openrouterModelId` + a cached label) in the
  existing model/effort store slice so a page reload doesn't silently fall
  back to the bare default without explanation.
- No new dependency: reuse the existing `DropdownMenu*` primitives with a
  plain controlled `<input>` for search (matches this repo's "no new UI
  dependency without cause" convention — the Notes artifact's search already
  sets this precedent of a hand-rolled filter, not a library).

## 6. Backward compatibility & persisted history

- A chat whose history contains a `role: assistant` turn made under the old
  fixed `openrouter-gpt-latest` (no `openrouterModelId`) replays unchanged —
  the field is optional and its absence means "use the configured default,"
  identical to current behavior. No migration needed.
- `sanitizePersistedToolArgs`/history redaction rules are untouched — this
  feature adds no new tool, only a new optional field on the existing
  `user_message` frame.

## 7. Deployment

- Schema change touches `packages/shared-types` (new optional field) and
  `apps/agent-service` (new module + WS handler branch + `resolveModel`
  signature) and `apps/terminal` (composer UI) — **all three tiers change**,
  unlike the env-only follow-up from the fixed-model rollout. A deployed
  local-prod stack needs both `./build-prod.sh` (composer changes) **and** a
  `prod-agent` restart (per [LOCAL-PROD.md](LOCAL-PROD.md); never a raw
  `pnpm build`).
- No new env var is strictly required (`OPENROUTER_CATALOG_TTL_MS` is
  optional, sensible default). Existing `OPENROUTER_*` vars are unchanged in
  meaning.
- Rollback: if the catalog feature causes trouble, the WS handler branch and
  the new composer search row can be reverted independently of the base
  fixed-model provider — the base provider (§ shipped already) keeps working
  with `openrouterModelId` simply never being sent.

## 8. Test matrix (focused, not exhaustive)

- `openrouter-catalog.test.ts`: fetch → reduce → cache TTL → stale-on-failure,
  against a local mock HTTP server (same pattern as `agent-loop-openrouter.test.ts`).
- `resolveModel("openrouter-gpt-latest", <validId>)` resolves to that id;
  an unknown id resolves `undefined` (never forwarded upstream unchecked).
  A model with no `reasoning` field yields `supportsReasoningEffort: false`.
- WS round trip: `openrouter_models_request` → `openrouter_models_response`
  with a non-empty list when configured, empty when not.
- Composer unit test: the new search row is absent when
  `openrouter-gpt-latest` isn't in `availableModels`; selecting a result
  updates local state and the effort menu narrows to that model's
  `supported_efforts`.
- Full existing suites (`agent-service` test/typecheck, `terminal` typecheck)
  stay green — no regression to Azure/Ark/Codex CLI paths.

## 9. Explicitly out of scope (this iteration)

- Editing/removing the picker's native model entries.
- Any admin-side curation/allowlist layer on top of the open catalog (could
  be added later as an env-configured id-prefix filter if ever needed, but
  is not requested and adds a second source of truth to keep in sync).
- Persisting per-chat OpenRouter model choice across chats/devices beyond the
  existing local composer-state persistence mechanism.
- Any change to approval/tool-calling behavior — a dynamically-selected
  OpenRouter model is still just a `ResolvedModel`, subject to the exact same
  approval gate, caps, and history rules verified in task 1.4.
