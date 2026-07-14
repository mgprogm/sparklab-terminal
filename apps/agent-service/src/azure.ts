/**
 * Azure OpenAI client for the gpt-5.6-sol deployment on AI Foundry.
 *
 * The custom agent loop (agent-loop.ts) drives this directly — there is no SDK
 * agent runtime. We use the standard chat.completions streaming API with tool
 * calling; the deployment name IS the model id passed to `create`.
 */
import { AzureOpenAI } from "openai";
import { config } from "./config.js";

export const azure = new AzureOpenAI({
  endpoint: config.azure.endpoint,
  apiKey: config.azure.apiKey,
  apiVersion: config.azure.apiVersion,
  deployment: config.azure.deployment,
});

/** The model id passed to chat.completions.create — the Azure deployment name. */
export const MODEL = config.azure.deployment;
