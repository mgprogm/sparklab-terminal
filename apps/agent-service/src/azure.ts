/**
 * Model registry for the agent loop.
 *
 * The custom agent loop (agent-loop.ts) drives these clients directly — there
 * is no SDK agent runtime. We use the standard chat.completions streaming API
 * with tool calling.
 *
 * Two providers:
 *   - Azure OpenAI (AI Foundry) for the GPT-5.6 deployments — the deployment
 *     name IS the model id passed to `create`.
 *   - BytePlus Ark (optional, OpenAI-compatible REST) for the `*-byteplus`
 *     models (DeepSeek V4 Pro / V3.2, GLM) — Bearer auth via a plain OpenAI
 *     client pointed at Ark's base URL, no `reasoning_effort` (that field is
 *     GPT-5.6-specific), and for DeepSeek the `thinking` flag merged into the
 *     request body.
 */
import OpenAI, { AzureOpenAI } from "openai";
import type { AgentModel } from "@sparklab/shared-types";
import { config } from "./config.js";

export const azure = new AzureOpenAI({
  endpoint: config.azure.endpoint,
  apiKey: config.azure.apiKey,
  apiVersion: config.azure.apiVersion,
});

const deployments: Partial<Record<AgentModel, string>> = {
  "gpt-5.6-sol": config.azure.deployments.sol,
  "gpt-5.6-terra": config.azure.deployments.terra,
  "gpt-5.6-luna": config.azure.deployments.luna,
};

/** Lazily built only when ARK_API_KEY is configured. */
const byteplus: OpenAI | undefined = config.byteplus.apiKey
  ? new OpenAI({
      baseURL: `${config.byteplus.baseUrl}/api/v3`,
      apiKey: config.byteplus.apiKey,
    })
  : undefined;

/**
 * The BytePlus Ark model roster, in picker order. `deployment` is the id sent
 * to Ark (env-overridable, see config.ts). DeepSeek takes a `thinking` body
 * flag — kept disabled; GLM does not.
 */
const arkModels: {
  id: AgentModel;
  deployment: string;
  extraBody?: Record<string, unknown>;
}[] = [
  {
    id: "deepseek-v4-pro-byteplus",
    deployment: config.byteplus.deepseekV4Pro,
    extraBody: { thinking: { type: "disabled" } },
  },
  {
    id: "deepseek-v32-byteplus",
    deployment: config.byteplus.deepseekV32,
    extraBody: { thinking: { type: "disabled" } },
  },
  {
    id: "glm-byteplus",
    deployment: config.byteplus.glm,
  },
];

export const DEFAULT_MODEL: AgentModel = "gpt-5.6-sol";

/** Public ids that have a provider configured on this service. */
export const availableModels = (): AgentModel[] => {
  const out = (Object.keys(deployments) as AgentModel[]).filter(
    (model) => deployments[model] !== undefined,
  );
  if (byteplus) out.push(...arkModels.map((m) => m.id));
  return out;
};

export interface ResolvedModel {
  /** AzureOpenAI extends OpenAI, so both providers share this type. */
  client: OpenAI;
  /** The `model` value sent to chat.completions.create. */
  deployment: string;
  /** GPT-5.6 `reasoning_effort` is Azure-only; DeepSeek / Ark rejects it. */
  supportsReasoningEffort: boolean;
  /** Extra JSON body params merged into the request (Ark's `thinking` flag). */
  extraBody?: Record<string, unknown>;
}

/**
 * Resolve an allowlisted public model id to its provider client + deployment.
 * Returns undefined when the model has no provider configured (the caller
 * surfaces a clean "model not configured" error).
 */
export function resolveModel(model: AgentModel): ResolvedModel | undefined {
  const ark = arkModels.find((m) => m.id === model);
  if (ark) {
    if (!byteplus) return undefined;
    return {
      client: byteplus,
      deployment: ark.deployment,
      supportsReasoningEffort: false,
      extraBody: ark.extraBody,
    };
  }
  const deployment = deployments[model];
  if (!deployment) return undefined;
  return { client: azure, deployment, supportsReasoningEffort: true };
}
