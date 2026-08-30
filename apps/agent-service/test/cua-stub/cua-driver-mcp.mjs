/**
 * Stub `cua-driver mcp --direct` for the Virtual Computer end-to-end test.
 * Newline-delimited JSON-RPC over stdin/stdout. Answers exactly the tools
 * ComputerRuntime calls, with shapes matching the checkout's contract docs
 * (docs/action-result-contract.md, action-icon-catalog.md).
 */
import { createInterface } from "node:readline";

// A real 1x1 PNG (67 bytes decoded) — bounded, valid base64.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function toolResult(id, name) {
  if (name === "get_desktop_state" || name === "screenshot") {
    return {
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ viewport: { width: 800, height: 600 } }),
          },
          { type: "image", mimeType: "image/png", data: PNG_1X1 },
        ],
      },
    };
  }
  if (name === "get_accessibility_tree") {
    return {
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              snapshot_id: "drv-e2e-1",
              elements: [
                {
                  index: 0,
                  role: "button",
                  name: "OK",
                  bounds: { x: 10, y: 20, width: 60, height: 24 },
                },
                { index: 1, role: "field", name: "Name" },
              ],
            }),
          },
        ],
      },
    };
  }
  if (name === "get_screen_size") {
    return {
      id,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ width: 800, height: 600 }) },
        ],
      },
    };
  }
  if (
    [
      "click",
      "double_click",
      "right_click",
      "drag",
      "type_text",
      "press_key",
      "hotkey",
      "scroll",
    ].includes(name)
  ) {
    return {
      id,
      result: {
        content: [],
        structuredContent: {
          effect: "confirmed",
          route: "accessibility",
          delivery: { mode: "background" },
          evidence: [{ kind: "value_readback" }],
        },
      },
    };
  }
  return { id, result: { content: [], isError: true } };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof msg.id !== "number") return; // notification, e.g. notifications/initialized
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "cua-driver-stub", version: "0.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    send(toolResult(msg.id, msg.params?.name));
    return;
  }
  send({ id: msg.id, result: { content: [], isError: true } });
});
