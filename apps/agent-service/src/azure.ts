/**
 * Azure OpenAI client for the GPT-5.6 deployments on AI Foundry.
 *
 * The custom agent loop (agent-loop.ts) drives this directly — there is no SDK
 * agent runtime. We use the standard chat.completions streaming API with tool
 * calling; the deployment name IS the model id passed to `create`.
 */
import { AzureOpenAI } from "openai";
import type { AgentModel } from "@sparklab/shared-types";
import { config } from "./config.js";

export const azure = new AzureOpenAI({
  endpoint: config.azure.endpoint,
  apiKey: config.azure.apiKey,
  apiVersion: config.azure.apiVersion,
});

const deployments: Record<AgentModel, string | undefined> = {
  "gpt-5.6-sol": config.azure.deployments.sol,
  "gpt-5.6-terra": config.azure.deployments.terra,
  "gpt-5.6-luna": config.azure.deployments.luna,
};

export const DEFAULT_MODEL: AgentModel = "gpt-5.6-sol";

/** Public ids that have an Azure AI Foundry deployment configured. */
export const availableModels = (): AgentModel[] =>
  (Object.keys(deployments) as AgentModel[]).filter(
    (model) => deployments[model] !== undefined,
  );

/** Resolve an allowlisted public model id to its private Azure deployment. */
export function deploymentFor(model: AgentModel): string | undefined {
  return deployments[model];
}
