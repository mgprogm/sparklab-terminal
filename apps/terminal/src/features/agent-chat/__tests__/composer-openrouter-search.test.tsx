/**
 * Covers the OpenRouter dynamic-catalog search picker added to the composer's
 * model dropdown: the search entry point's visibility gate, client-side
 * filtering over the fetched catalog, and per-model reasoning-effort
 * narrowing once a specific catalog model is selected.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Composer } from "../components/composer";
import { useAgentStore } from "../store";

import type { OpenRouterCatalogModel } from "@sparklab/shared-types";

function reset() {
  useAgentStore.setState({
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    availableModels: ["gpt-5.6-sol"],
    availableReasoningEfforts: [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
    openrouterCatalog: [],
    openrouterCatalogLoading: false,
    openrouterCatalogFetchedAt: null,
    openrouterModelId: null,
    openrouterModelLabel: null,
    openrouterModelSupportedEfforts: null,
    pinnedTargetId: null,
    status: "idle",
  });
}

const noop = () => {};
const openPicker = () =>
  userEvent.click(
    screen.getByLabelText("Choose agent model and reasoning effort"),
  );

describe("Composer — OpenRouter search picker", () => {
  beforeEach(reset);
  afterEach(reset);

  it("hides the search entry point when the provider isn't advertised", async () => {
    render(
      <Composer
        sessions={[]}
        activeSessionId={null}
        onSend={noop}
        onStop={noop}
      />,
    );
    await openPicker();
    expect(
      screen.queryByText(/Search OpenRouter models/),
    ).not.toBeInTheDocument();
  });

  it("shows the search entry point and filters the fetched catalog by id/name", async () => {
    const catalog: OpenRouterCatalogModel[] = [
      {
        id: "openai/gpt-6-astra",
        name: "OpenAI: GPT-6 Astra",
        contextLength: 1_050_000,
        pricing: { prompt: "0.00001", completion: "0.00005" },
      },
      {
        id: "z-ai/glm-5.2:free",
        name: "GLM 5.2 (free)",
        contextLength: 128_000,
        pricing: { prompt: "0", completion: "0" },
      },
    ];
    useAgentStore.setState({
      availableModels: ["gpt-5.6-sol", "openrouter-gpt-latest"],
      openrouterCatalog: catalog,
    });
    render(
      <Composer
        sessions={[]}
        activeSessionId={null}
        onSend={noop}
        onStop={noop}
      />,
    );
    await openPicker();
    await userEvent.click(screen.getByText(/Search OpenRouter models/));

    expect(screen.getByText("OpenAI: GPT-6 Astra")).toBeInTheDocument();
    expect(screen.getByText("GLM 5.2 (free)")).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText(/Search OpenRouter models/),
      "glm",
    );
    expect(screen.queryByText("OpenAI: GPT-6 Astra")).not.toBeInTheDocument();
    expect(screen.getByText("GLM 5.2 (free)")).toBeInTheDocument();
  });

  it("narrows the reasoning-effort menu to the selected model's supported efforts", async () => {
    const catalog: OpenRouterCatalogModel[] = [
      {
        id: "mandatory/reasoner",
        name: "Mandatory Reasoner",
        contextLength: 32_000,
        pricing: { prompt: "0", completion: "0" },
        reasoning: {
          supportedEfforts: ["low", "medium"],
          mandatory: true,
          defaultEffort: "medium",
        },
      },
    ];
    useAgentStore.setState({
      availableModels: ["gpt-5.6-sol", "openrouter-gpt-latest"],
      openrouterCatalog: catalog,
    });
    render(
      <Composer
        sessions={[]}
        activeSessionId={null}
        onSend={noop}
        onStop={noop}
      />,
    );
    await openPicker();
    await userEvent.click(screen.getByText(/Search OpenRouter models/));
    await userEvent.click(screen.getByText("Mandatory Reasoner"));

    // Selecting a result closes the menu; reopen to inspect the trigger
    // label and the (now narrowed) effort menu.
    expect(useAgentStore.getState().openrouterModelId).toBe(
      "mandatory/reasoner",
    );
    expect(screen.getByText(/Mandatory Reasoner/)).toBeInTheDocument(); // trigger label
    await openPicker();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.queryByText("Extra high")).not.toBeInTheDocument();
    expect(screen.queryByText("Max")).not.toBeInTheDocument();
    expect(screen.queryByText("None")).not.toBeInTheDocument();
  });

  it("has no plain 'GPT Latest' row — OpenRouter is reachable only via search", async () => {
    useAgentStore.setState({
      availableModels: ["gpt-5.6-sol", "openrouter-gpt-latest"],
    });
    render(
      <Composer
        sessions={[]}
        activeSessionId={null}
        onSend={noop}
        onStop={noop}
      />,
    );
    await openPicker();

    expect(screen.queryByText("GPT Latest")).not.toBeInTheDocument();
    expect(screen.getByText(/Search OpenRouter models/)).toBeInTheDocument();
  });
});
