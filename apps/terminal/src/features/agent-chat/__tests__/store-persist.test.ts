import { describe, expect, it } from "vitest";

import { useAgentStore } from "../store";

describe("agent chat persistence", () => {
  it("persists latest chat ids by terminal instead of one global chat id", () => {
    const options = useAgentStore.persist.getOptions();
    const persisted = options.partialize!({
      ...useAgentStore.getState(),
      chatId: "currently-rendered",
      terminalSessionId: "local/web-a",
      chatIdsByTerminal: {
        "local/web-a": "chat-a",
        "local/web-b": "chat-b",
      },
    });

    expect(persisted).toMatchObject({
      chatIdsByTerminal: {
        "local/web-a": "chat-a",
        "local/web-b": "chat-b",
      },
    });
    expect(persisted).not.toHaveProperty("chatId");
    expect(persisted).not.toHaveProperty("terminalSessionId");
    expect(persisted).not.toHaveProperty("entries");
  });

  it("migrates the former global chat id as a one-time legacy candidate", async () => {
    const migrate = useAgentStore.persist.getOptions().migrate!;
    const migrated = (await migrate(
      { panelOpen: true, chatId: "legacy-chat" },
      0,
    )) as ReturnType<typeof useAgentStore.getState>;

    expect(migrated.chatId).toBeNull();
    expect(migrated.legacyChatId).toBe("legacy-chat");
    expect(migrated.chatIdsByTerminal).toEqual({});
  });
});
