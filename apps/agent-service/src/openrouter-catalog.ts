/**
 * Fetches, reduces, and caches OpenRouter's live model catalog
 * (`GET {baseUrl}/models`) for the dynamic model-search picker. Server-side
 * only — the browser never talks to OpenRouter directly. A refetch failure
 * serves the last-known-good cached list rather than erroring, so a
 * transient OpenRouter outage never breaks the picker for models the user
 * already saw. Hidden entirely (empty list, no fetch attempted) when
 * OpenRouter isn't configured, mirroring the rest of this provider's
 * "absent unless configured" behavior.
 */
import {
  AgentReasoningEffortSchema,
  OpenRouterCatalogModelSchema,
} from "@sparklab/shared-types";
import type { OpenRouterCatalogModel } from "@sparklab/shared-types";
import { config } from "./config.js";

const FETCH_TIMEOUT_MS = 5000;

interface RawOpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  reasoning?: {
    supported_efforts?: unknown;
    mandatory?: unknown;
    default_effort?: unknown;
  };
}

interface Cache {
  models: OpenRouterCatalogModel[];
  fetchedAt: number;
}

let cache: Cache | null = null;
// Coalesces concurrent callers during a single in-flight fetch/refetch so a
// burst of picker-opens doesn't fan out into multiple upstream requests.
let inFlight: Promise<Cache> | null = null;

const VALID_EFFORTS: ReadonlySet<string> = new Set(
  AgentReasoningEffortSchema.options,
);

function reduceOne(raw: RawOpenRouterModel): OpenRouterCatalogModel | null {
  const supportedEfforts = Array.isArray(raw.reasoning?.supported_efforts)
    ? raw.reasoning!.supported_efforts.filter(
        (e): e is string => typeof e === "string" && VALID_EFFORTS.has(e),
      )
    : [];
  const candidate = {
    id: raw.id,
    name: raw.name,
    contextLength: raw.context_length,
    pricing: {
      prompt: raw.pricing?.prompt ?? "0",
      completion: raw.pricing?.completion ?? "0",
    },
    ...(raw.reasoning && supportedEfforts.length > 0
      ? {
          reasoning: {
            supportedEfforts,
            mandatory: raw.reasoning.mandatory === true,
            ...(typeof raw.reasoning.default_effort === "string" &&
            VALID_EFFORTS.has(raw.reasoning.default_effort)
              ? { defaultEffort: raw.reasoning.default_effort }
              : {}),
          },
        }
      : {}),
  };
  const parsed = OpenRouterCatalogModelSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

async function fetchAndReduce(): Promise<OpenRouterCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.openrouter.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    const raw = Array.isArray(body.data)
      ? (body.data as RawOpenRouterModel[])
      : [];
    const models: OpenRouterCatalogModel[] = [];
    for (const entry of raw) {
      const reduced = reduceOne(entry);
      if (reduced) models.push(reduced);
    }
    return models;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns the current OpenRouter catalog, refreshing it when the cache is
 * absent or past its TTL. Never throws: a refetch failure logs and falls
 * back to the last-known-good cache (or an empty list if none exists yet).
 */
export async function getOpenRouterCatalog(): Promise<Cache> {
  if (!config.openrouter.apiKey) return { models: [], fetchedAt: Date.now() };

  const fresh =
    cache && Date.now() - cache.fetchedAt < config.openrouter.catalogTtlMs;
  if (fresh) return cache!;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const models = await fetchAndReduce();
      cache = { models, fetchedAt: Date.now() };
      return cache;
    } catch (err) {
      console.error(
        "[agent] OpenRouter catalog fetch failed, serving",
        cache ? "stale cache" : "empty list",
        "-",
        err instanceof Error ? err.message : err,
      );
      // Stale-on-failure: keep serving the last-known-good list untouched.
      // Only synthesize an empty result when nothing has ever been fetched.
      return cache ?? { models: [], fetchedAt: Date.now() };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
