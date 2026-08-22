/**
 * The agent's entire capability surface: terminal and virtual-browser tools,
 * defined as OpenAI function-calling schemas.
 *
 * Because the loop is ours, there are no built-in tools to disable — these are
 * the only things the model can do, and every one flows through tmux-owned
 * processes via the gateway or the isolated Browser Use runtime.
 *
 *   READ  (auto):  list_sessions, read_screen, wait_idle,
 *                  browser_observe, browser_list_tabs
 *   WRITE (ask):   type_text, press_keys, run_command, create_session,
 *                  run_codex, browser_act, browser_capture, browser_request_handoff
 *
 * There is deliberately no kill_session — destroying a session stays a
 * human-only act in the UI.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { AgentNamedKeySchema } from "@sparklab/shared-types";
import { gateway, GatewayError } from "./gateway-client.js";

export const WRITE_TOOLS = new Set([
  "type_text",
  "press_keys",
  "schedule_terminal_action",
  "cancel_scheduled_terminal_action",
  "run_command",
  "create_session",
  "run_codex",
  "browser_act",
  "browser_capture",
  "browser_request_handoff",
  // Kanban writes (D9). The routine four permit allow-always; kanban_delete is
  // additionally in ONE_TIME_TOOLS so it is re-approved on every call.
  "kanban_create",
  "kanban_move",
  "kanban_add_card",
  "kanban_update_card",
  "kanban_delete",
  // PM writes (D12). The routine writes permit allow-always; pm_delete_project
  // and pm_delete_column are additionally in ONE_TIME_TOOLS so they are
  // re-approved on every call. The PM reads are deliberately absent.
  "pm_create_project",
  "pm_delete_project",
  "pm_add_task",
  "pm_update_task",
  "pm_move_task",
  "pm_add_sprint",
  // Column writes (§3.7). pm_delete_column is one-time (can strand/relocate many tasks).
  "pm_add_column",
  "pm_update_column",
  "pm_delete_column",
  "pm_move_column",
  // PM collaboration writes (Phase 3 §4.8). Comment + watch/unwatch are allow-always.
  "pm_add_comment",
  "pm_watch_task",
  "pm_unwatch_task",
]);

/**
 * WRITE tools consequential enough that each invocation is approved
 * INDIVIDUALLY — the loop passes `allowAlways: false` for these, so an
 * "allow always" choice is coerced to a one-time allow (see agent-loop.ts).
 * kanban_delete (destroying a whole board) joins the browser/Codex writes here
 * per D9 in docs/KANBAN-PLAN.md; the routine kanban writes are NOT listed and
 * so may be allowed-always.
 */
export const ONE_TIME_TOOLS = new Set([
  // A delayed key press is autonomous terminal input: every schedule must be
  // explicitly approved, never inherited from an earlier allow-always choice.
  "schedule_terminal_action",
  "browser_act",
  "browser_capture",
  "browser_request_handoff",
  "run_codex",
  "kanban_delete",
  // Destroying a whole project is coerced one-time (D12), like kanban_delete.
  // The routine PM writes are NOT listed and so may be allowed-always.
  "pm_delete_project",
  // Deleting a column can strand/relocate many tasks — coerce one-time (§3.7).
  "pm_delete_column",
]);

const NAMED_KEYS = AgentNamedKeySchema.options;

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "browser_capture",
      description:
        "Capture the current isolated-browser viewport and save the PNG/WebP bytes to an absolute path on the server of the selected terminal session. The parent directory must already exist and an existing file is overwritten. Always requires one-time user approval. The screenshot is also shown in Browser View but is never stored in chat history.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description:
              "Target terminal session whose server will receive the screenshot file.",
          },
          path: {
            type: "string",
            description:
              "Absolute destination file path, for example /home/user/project/screenshots/page.png.",
          },
        },
        required: ["session_id", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_scheduled_terminal_actions",
      description:
        "List persisted one-time terminal actions and their status. Read-only.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_scheduled_terminal_action",
      description:
        "Cancel a pending one-time terminal action by id. Requires user approval. It cannot cancel an action already executing or completed.",
      parameters: {
        type: "object",
        properties: { action_id: { type: "string", minLength: 1 } },
        required: ["action_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_request_handoff",
      description:
        "Offer the current isolated browser to the user for password/MFA entry. Use when the user explicitly asks to take control, asks to reopen an existing handoff view, or a login requires secrets. This requires user approval, starts or reopens the private human-only channel, and never returns typed input. After calling it, stop using browser tools and tell the user to finish or cancel the handoff in the browser view.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_observe",
      description:
        "Observe the current browser page: URL, title, viewport, indexed interactive elements, and screenshot. Starts an isolated browser lazily. Call before every browser action.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_list_tabs",
      description: "List tabs in this chat's isolated browser.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_act",
      description:
        "Perform exactly one browser action. Always requires one-time user approval. Observe first and use indexed elements. Type only non-secret data explicitly supplied for this task.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "navigate",
              "click",
              "type",
              "scroll",
              "go_back",
              "switch_tab",
              "close_tab",
            ],
          },
          url: {
            type: "string",
            maxLength: 2048,
            description: "Absolute public HTTP(S) URL for navigate.",
          },
          new_tab: { type: "boolean" },
          index: { type: "integer", minimum: 0, maximum: 100000 },
          text: { type: "string", maxLength: 10000 },
          direction: { type: "string", enum: ["up", "down"] },
          tab_id: { type: "string", minLength: 1, maxLength: 64 },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description:
        "List all terminal sessions with their human name, id, currently-running command, attached state, and last activity. Call this first to discover what terminals exist.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_screen",
      description:
        "Read the plain-text contents of a terminal's screen (no colors). Use before acting so you know what is currently shown and whether a job is running.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Target session id (web-...).",
          },
          history_lines: {
            type: "integer",
            minimum: 0,
            maximum: 2000,
            description:
              "Optional lines of scrollback above the visible screen (default 0).",
          },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_idle",
      description:
        "Block until a terminal looks idle: its running command returns to a shell, or the screen stops changing. Use after starting something to know when it finished. Returns the final screen.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
          quiet_ms: { type: "integer", minimum: 250, maximum: 30000 },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Type literal text into a terminal. This NEVER executes — no Enter is sent. Use for filling a prompt, then press_keys ['Enter'] to run. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 10000 },
        },
        required: ["session_id", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_keys",
      description: `Send one or more named keys to a terminal (in order). Allowed keys: ${NAMED_KEYS.join(", ")}. Use 'Enter' to run a typed command, 'C-c' to interrupt. Requires user approval.`,
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          keys: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", enum: NAMED_KEYS },
          },
        },
        required: ["session_id", "keys"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_terminal_action",
      description:
        "Schedule a one-time named-key action in a terminal. The action persists if chat disconnects, and requires approval now. Use only for an explicit user request. execute_at must be an unambiguous ISO-8601 date-time including timezone, for example 2026-08-22T22:30:00+07:00. Only named keys can be scheduled; text and commands cannot.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          keys: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", enum: NAMED_KEYS },
          },
          execute_at: {
            type: "string",
            description: "ISO-8601 date-time with timezone offset.",
          },
        },
        required: ["session_id", "keys", "execute_at"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Type a shell command, press Enter, and wait for it to finish. Returns the resulting screen. The single approval shows the exact command. Use this for ordinary non-interactive commands.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          command: { type: "string", minLength: 1, maxLength: 10000 },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        required: ["session_id", "command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_session",
      description:
        "Create a new terminal session and return its id. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional display name." },
          cwd: { type: "string", description: "Optional working directory." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_codex",
      description:
        "Hand a single self-contained task to the Codex CLI coding agent. It runs NON-INTERACTIVELY, rooted at the selected session's working directory, on that session's server, with no network access. Requires user approval EVERY time — the exact task and mode are shown. Default mode 'read-only' makes no file changes (use for review, explanations, investigation). Pass mode 'workspace-write' ONLY when the user wants Codex to modify files, and say so first — its edits are confined to the session's working directory. Note: Codex can still READ files elsewhere on the server, so treat its output like any command output (it may surface file contents). Returns Codex's output and exit code.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description:
              "Target session id (web-...). Codex runs in this session's cwd.",
          },
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: 16384,
            description:
              "The complete instruction for Codex. Be specific; it is one non-interactive run.",
          },
          mode: {
            type: "string",
            enum: ["read-only", "workspace-write"],
            description:
              "Sandbox policy. 'read-only' (default) cannot modify files; 'workspace-write' may edit files within the session cwd only.",
          },
        },
        required: ["session_id", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_list",
      description:
        "List all Kanban boards (id, name, tags, rev, card/column counts). Read-only. Call this first to discover which boards exist before getting or mutating one.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_get",
      description:
        "Get one Kanban board in full: its columns (with ordered cardIds), all cards, and the board's current rev. Read-only. Use before moving or editing cards so you know the column ids and card ids.",
      parameters: {
        type: "object",
        properties: {
          board_id: {
            type: "string",
            description: "Target board id (kb-...).",
          },
        },
        required: ["board_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_create",
      description:
        "Create a new Kanban board. Columns default to Backlog / To Do / In Progress / Done when not supplied. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          columns: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 128 },
            description:
              "Optional ordered column names; omit for the defaults.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_delete",
      description:
        "Delete an entire Kanban board and all its cards. This is destructive and requires user approval EVERY time (no allow-always). Confirm the board id first.",
      parameters: {
        type: "object",
        properties: {
          board_id: {
            type: "string",
            description: "Board id to delete (kb-...).",
          },
        },
        required: ["board_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_move",
      description:
        "Move a card to a column at a given position (also used to reorder within a column). You supply board_id, card_id, to_column_id, and to_index; you do NOT manage the board rev — the tool reads it and retries on a concurrent change. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          board_id: { type: "string" },
          card_id: { type: "string" },
          to_column_id: {
            type: "string",
            description: "Destination column id (from kanban_get).",
          },
          to_index: {
            type: "integer",
            minimum: 0,
            description: "0-based position within the destination column.",
          },
        },
        required: ["board_id", "card_id", "to_column_id", "to_index"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_add_card",
      description:
        "Add a card to a board. Lands in the given column, or the first column when column_id is omitted. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          board_id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 512 },
          description: { type: "string", maxLength: 8192 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          column_id: {
            type: "string",
            description:
              "Optional destination column id; omit for the first column.",
          },
        },
        required: ["board_id", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kanban_update_card",
      description:
        "Update a card's title, description, and/or tags. Provide at least one field to change. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          board_id: { type: "string" },
          card_id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 512 },
          description: { type: "string", maxLength: 8192 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        required: ["board_id", "card_id"],
        additionalProperties: false,
      },
    },
  },
  // --- Project management (PM) ---------------------------------------------
  // A richer sibling of Kanban: projects hold tasks with assignee, priority,
  // labels, start/due dates, an optional sprint, and dependencies on other
  // tasks in the same project. Reads are auto; writes are approval-gated.
  {
    type: "function",
    function: {
      name: "pm_list_projects",
      description:
        "List all project-management projects (id, name, tags, rev, column/task/sprint counts). Read-only. Call this first to discover which projects exist before getting or mutating one.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_get_project",
      description:
        "Get one project in full: its columns (with ordered taskIds), sprints, all tasks (each with its derived columnId), and the project's current rev. Read-only. Use before adding, moving, or editing tasks so you know the column ids, sprint ids, and task ids.",
      parameters: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Target project id (pm-...).",
          },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_get_tree",
      description:
        "Get a project's issue hierarchy as a forest: root tasks (no parent) each with a nested `children` array (Epic→Story→Subtask). Read-only. Use to understand parent/child structure before re-parenting or changing types.",
      parameters: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Target project id (pm-...).",
          },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_create_project",
      description:
        "Create a new project. Columns default to Backlog / To Do / In Progress / Done when not supplied. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          columns: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 128 },
            description:
              "Optional ordered column names; omit for the defaults.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_delete_project",
      description:
        "Delete an entire project and all its tasks and sprints. This is destructive and requires user approval EVERY time (no allow-always). Confirm the project id first.",
      parameters: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Project id to delete (pm-...).",
          },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_add_task",
      description:
        "Add a task to a project. Lands in the given column, or the first column (Backlog) when column_id is omitted. Optional fields: type (epic/story/task/bug/subtask; default task), a parent task id (hierarchy — Epic→Story/Task/Bug→Subtask; a Subtask requires a parent), assignee, priority, labels, start/due dates (epoch ms, day-level), a sprint, and dependencies on other tasks in the same project. An invalid type/parent combination is rejected. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 512 },
          description: { type: "string", maxLength: 8192 },
          type: {
            type: "string",
            enum: ["epic", "story", "task", "bug", "subtask"],
            description: "Issue type; defaults to task.",
          },
          parent_id: {
            type: ["string", "null"],
            description:
              "Parent task id (same project). Epic has no parent; Story/Task/Bug may parent under an Epic; a Subtask must parent under a Story/Task/Bug.",
          },
          assignee: { type: "string", maxLength: 128 },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
          },
          labels: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          start_date: {
            type: ["number", "null"],
            description: "Start date as epoch ms (day-level), or null.",
          },
          due_date: {
            type: ["number", "null"],
            description: "Due date as epoch ms (day-level), or null.",
          },
          sprint_id: {
            type: ["string", "null"],
            description: "Owning sprint id, or null for the backlog.",
          },
          column_id: {
            type: "string",
            description:
              "Optional destination column id; omit for the first column.",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Ids of tasks in this project this task depends on.",
          },
        },
        required: ["project_id", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_update_task",
      description:
        "Update a task's fields, its type/parent (hierarchy), and/or its dependency set. Provide at least one field to change. Set depends_on to the FULL list of task ids this task should depend on (it replaces the existing set). A change that would create a dependency cycle, or that violates the Epic→Story/Task/Bug→Subtask hierarchy, is rejected. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 512 },
          description: { type: "string", maxLength: 8192 },
          type: {
            type: "string",
            enum: ["epic", "story", "task", "bug", "subtask"],
            description: "Issue type.",
          },
          parent_id: {
            type: ["string", "null"],
            description:
              "Parent task id (same project), or null to detach. Validated against the hierarchy matrix.",
          },
          assignee: { type: ["string", "null"], maxLength: 128 },
          priority: {
            type: ["string", "null"],
            enum: ["low", "medium", "high", "urgent", null],
          },
          labels: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          start_date: {
            type: ["number", "null"],
            description: "Start date as epoch ms (day-level), or null.",
          },
          due_date: {
            type: ["number", "null"],
            description: "Due date as epoch ms (day-level), or null.",
          },
          sprint_id: {
            type: ["string", "null"],
            description: "Owning sprint id, or null for the backlog.",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description:
              "Full replacement list of task ids this task depends on.",
          },
        },
        required: ["project_id", "task_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_move_task",
      description:
        "Move a task to a column at a given position (also used to reorder within a column — this is how you change a task's status). You supply project_id, task_id, to_column_id, and to_index; you do NOT manage the project rev — the tool reads it and retries on a concurrent change. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
          to_column_id: {
            type: "string",
            description: "Destination column id (from pm_get_project).",
          },
          to_index: {
            type: "integer",
            minimum: 0,
            description: "0-based position within the destination column.",
          },
        },
        required: ["project_id", "task_id", "to_column_id", "to_index"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_add_sprint",
      description:
        "Add a sprint / iteration to a project. Sprints are orthogonal to columns — a task can be In Progress and in a sprint at once. Optional start/end dates are epoch ms (day-level). Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 128 },
          start_date: {
            type: ["number", "null"],
            description: "Sprint start as epoch ms (day-level), or null.",
          },
          end_date: {
            type: ["number", "null"],
            description: "Sprint end as epoch ms (day-level), or null.",
          },
        },
        required: ["project_id", "name"],
        additionalProperties: false,
      },
    },
  },
  // --- Column management (§3.7) ----------------------------------------------
  {
    type: "function",
    function: {
      name: "pm_add_column",
      description:
        "Add a status column to a project. Optional: index (insertion point, 0-based; default = end), wip_limit (positive int, hard-blocks moves/creates when full), transitions (array of column ids that tasks may move to from this column; null = any). Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 128 },
          index: {
            type: "integer",
            minimum: 0,
            description: "0-based insertion index; omit for end.",
          },
          wip_limit: {
            type: ["integer", "null"],
            minimum: 1,
            description: "Max tasks in this column, or null for unlimited.",
          },
          transitions: {
            type: ["array", "null"],
            items: { type: "string" },
            description:
              "Column ids tasks may move TO from this column; null = any.",
          },
        },
        required: ["project_id", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_update_column",
      description:
        "Update a column's name, WIP limit, and/or allowed transitions. Last-writer-wins (no rev needed). Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          column_id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 128 },
          wip_limit: {
            type: ["integer", "null"],
            minimum: 1,
            description: "Max tasks, or null for unlimited.",
          },
          transitions: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Allowed destination column ids, or null = any.",
          },
        },
        required: ["project_id", "column_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_delete_column",
      description:
        "Delete a column. By default blocks if the column has tasks (mode 'block'); pass mode 'relocate' with to_column_id to append the tasks to another column instead. A project must keep at least one column. This is destructive and requires user approval EVERY time (no allow-always).",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          column_id: { type: "string" },
          mode: {
            type: "string",
            enum: ["block", "relocate"],
            description:
              "Default 'block'; 'relocate' moves tasks to to_column_id.",
          },
          to_column_id: {
            type: "string",
            description:
              "Target column for relocated tasks (required when mode='relocate').",
          },
        },
        required: ["project_id", "column_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_move_column",
      description:
        "Move a column to a new position (reorder). You supply project_id, column_id, and to_index; you do NOT manage the project rev — the tool reads it and retries on a concurrent change. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          column_id: { type: "string" },
          to_index: {
            type: "integer",
            minimum: 0,
            description: "0-based target position.",
          },
        },
        required: ["project_id", "column_id", "to_index"],
        additionalProperties: false,
      },
    },
  },
  // --- PM Collaboration (Phase 3 §4.8) ----------------------------------------
  {
    type: "function",
    function: {
      name: "pm_add_comment",
      description:
        "Add a comment to a task. The author is set to the acting agent identity. Also auto-watches the commenter on this task. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
          body: {
            type: "string",
            minLength: 1,
            maxLength: 8192,
            description: "Comment text (max 8192 chars).",
          },
        },
        required: ["project_id", "task_id", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_list_comments",
      description:
        "List all comments on a task, sorted by creation time (oldest first). Read-only.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
        },
        required: ["project_id", "task_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_list_activity",
      description:
        "List the activity / audit trail for a project, most recent first. Supports cursor-based pagination: pass `before` (epoch ms timestamp) to get entries older than that point. Read-only.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Max entries to return (default 50).",
          },
          before: {
            type: "number",
            description: "Only entries with ts < this value (epoch ms).",
          },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_watch_task",
      description:
        "Start watching a task (add the acting agent to the watchers list). Watchers receive in-app notifications on task changes. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
        },
        required: ["project_id", "task_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_unwatch_task",
      description:
        "Stop watching a task (remove the acting agent from the watchers list). Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
        },
        required: ["project_id", "task_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm_list_attachments",
      description:
        "List attachment metadata for a task (id, filename, size, contentType, actor, createdAt). Read-only. No upload tool — attachments are added by humans in the UI.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          task_id: { type: "string" },
        },
        required: ["project_id", "task_id"],
        additionalProperties: false,
      },
    },
  },
];

const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash"]);

export interface ToolArgs {
  session_id?: string;
  text?: string;
  keys?: string[];
  execute_at?: string;
  action_id?: string;
  command?: string;
  name?: string;
  cwd?: string;
  prompt?: string;
  mode?: string;
  history_lines?: number;
  timeout_ms?: number;
  quiet_ms?: number;
  action?: string;
  url?: string;
  new_tab?: boolean;
  index?: number;
  direction?: string;
  tab_id?: string;
  // Kanban
  board_id?: string;
  card_id?: string;
  to_column_id?: string;
  to_index?: number;
  column_id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  columns?: string[];
  // PM
  project_id?: string;
  task_id?: string;
  type?: string;
  parent_id?: string | null;
  reporter?: string | null;
  assignee?: string | null;
  priority?: string | null;
  labels?: string[];
  start_date?: number | null;
  due_date?: number | null;
  end_date?: number | null;
  sprint_id?: string | null;
  depends_on?: string[];
  // PM columns
  wip_limit?: number | null;
  transitions?: string[] | null;
  // PM collaboration (Phase 3)
  body?: string;
  limit?: number;
  before?: number;
  path?: string;
}

/** Which session a call targets (for UI attribution), if any. */
export function targetSession(args: ToolArgs): string | undefined {
  return typeof args.session_id === "string" ? args.session_id : undefined;
}

/** One-line human summary of a call, for the activity feed / approval card. */
export function describeCall(tool: string, args: ToolArgs): string {
  const truncate = (s: string, n = 200) =>
    s.length > n ? s.slice(0, n) + "…" : s;
  switch (tool) {
    case "list_sessions":
      return "list sessions";
    case "read_screen":
      return `read screen${args.history_lines ? ` (+${args.history_lines} history)` : ""}`;
    case "wait_idle":
      return "wait for idle";
    case "type_text":
      return `type: ${truncate(String(args.text ?? ""))}`;
    case "press_keys":
      return `press: ${(args.keys ?? []).join(" ")}`;
    case "schedule_terminal_action":
      return `schedule ${(args.keys ?? []).join(" ")} at ${args.execute_at ?? ""}`.trimEnd();
    case "list_scheduled_terminal_actions":
      return "list scheduled terminal actions";
    case "cancel_scheduled_terminal_action":
      return `cancel scheduled terminal action ${args.action_id ?? ""}`.trimEnd();
    case "run_command":
      return `run: ${truncate(String(args.command ?? ""))}`;
    case "create_session":
      return `create session${args.name ? ` "${args.name}"` : ""}`;
    case "run_codex":
      return `run Codex [${args.mode === "workspace-write" ? "workspace-write" : "read-only"}]: ${truncate(String(args.prompt ?? ""))}`;
    case "browser_observe":
      return "observe browser";
    case "browser_capture":
      return `capture browser screen to ${truncate(String(args.path ?? ""))}`;
    case "browser_request_handoff":
      return "take control of the isolated browser";
    case "browser_list_tabs":
      return "list browser tabs";
    case "browser_act":
      if (args.action === "type")
        return `type into browser element ${args.index ?? "?"}: [redacted]`;
      if (args.action === "navigate")
        return `navigate browser to ${truncate(String(args.url ?? ""))}`;
      if (args.action === "click")
        return `click browser element ${args.index ?? "?"}`;
      if (args.action === "scroll")
        return `scroll browser ${args.direction ?? ""}`;
      if (args.action === "switch_tab")
        return `switch to browser tab ${args.tab_id ?? ""}`;
      if (args.action === "close_tab")
        return `close browser tab ${args.tab_id ?? ""}`;
      return "go back in browser";
    case "kanban_list":
      return "list Kanban boards";
    case "kanban_get":
      return `get Kanban board ${args.board_id ?? ""}`.trimEnd();
    case "kanban_create":
      return `create Kanban board "${truncate(String(args.name ?? ""), 80)}"`;
    case "kanban_delete":
      return `delete Kanban board ${args.board_id ?? ""}`.trimEnd();
    case "kanban_move":
      return `move card ${args.card_id ?? ""} to column ${args.to_column_id ?? ""} (index ${args.to_index ?? 0})`;
    case "kanban_add_card":
      return `add card "${truncate(String(args.title ?? ""), 80)}"`;
    case "kanban_update_card":
      return `update card ${args.card_id ?? ""}`.trimEnd();
    case "pm_list_projects":
      return "list projects";
    case "pm_get_project":
      return `get project ${args.project_id ?? ""}`.trimEnd();
    case "pm_get_tree":
      return `get hierarchy tree for ${args.project_id ?? ""}`.trimEnd();
    case "pm_create_project":
      return `create project "${truncate(String(args.name ?? ""), 80)}"`;
    case "pm_delete_project":
      return `delete project ${args.project_id ?? ""}`.trimEnd();
    case "pm_add_task":
      return `add ${args.type ? String(args.type) : "task"} "${truncate(String(args.title ?? ""), 80)}"${args.parent_id ? ` under ${args.parent_id}` : ""}`;
    case "pm_update_task":
      return `update task ${args.task_id ?? ""}${args.type ? ` (type ${args.type})` : ""}${args.parent_id !== undefined ? " (set parent)" : ""}${args.depends_on ? " (set dependencies)" : ""}`.trimEnd();
    case "pm_move_task":
      return `move task ${args.task_id ?? ""} to column ${args.to_column_id ?? ""} (index ${args.to_index ?? 0})`;
    case "pm_add_sprint":
      return `add sprint "${truncate(String(args.name ?? ""), 80)}"`;
    case "pm_add_column":
      return `add column "${truncate(String(args.name ?? ""), 80)}"${args.wip_limit ? ` (WIP ${args.wip_limit})` : ""}`;
    case "pm_update_column":
      return `update column ${args.column_id ?? ""}${args.name ? ` name="${truncate(args.name, 40)}"` : ""}${args.wip_limit !== undefined ? ` wip=${args.wip_limit}` : ""}`.trimEnd();
    case "pm_delete_column":
      return `delete column ${args.column_id ?? ""}${args.mode === "relocate" ? ` (relocate to ${args.to_column_id ?? "?"})` : ""}`.trimEnd();
    case "pm_move_column":
      return `move column ${args.column_id ?? ""} to index ${args.to_index ?? 0}`;
    case "pm_add_comment":
      return `comment on task ${args.task_id ?? ""}: ${truncate(String(args.body ?? ""), 80)}`;
    case "pm_list_comments":
      return `list comments on task ${args.task_id ?? ""}`.trimEnd();
    case "pm_list_activity":
      return `list activity for project ${args.project_id ?? ""}`.trimEnd();
    case "pm_watch_task":
      return `watch task ${args.task_id ?? ""}`.trimEnd();
    case "pm_unwatch_task":
      return `unwatch task ${args.task_id ?? ""}`.trimEnd();
    case "pm_list_attachments":
      return `list attachments on task ${args.task_id ?? ""}`.trimEnd();
    default:
      return tool;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function waitIdle(
  sessionId: string,
  timeoutMs: number,
  quietMs: number,
  signal?: AbortSignal,
): Promise<{ idle_reason: string; screen: string }> {
  const start = Date.now();
  let lastScreen: string | null = null;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await gateway.readScreen(sessionId);
    if (SHELLS.has(s.currentCommand)) {
      return { idle_reason: "shell_prompt", screen: s.screen };
    }
    if (s.screen === lastScreen) {
      if (Date.now() - stableSince >= quietMs) {
        return { idle_reason: "quiet", screen: s.screen };
      }
    } else {
      lastScreen = s.screen;
      stableSince = Date.now();
    }
    await abortableSleep(500, signal);
  }
  const final = await gateway.readScreen(sessionId);
  return { idle_reason: "timeout", screen: final.screen };
}

/**
 * Execute a tool and return the string the model sees as the tool result.
 * Approval (for write tools) is handled by the caller BEFORE this runs.
 */
export async function executeTool(
  tool: string,
  args: ToolArgs,
  signal?: AbortSignal,
): Promise<string> {
  try {
    switch (tool) {
      case "list_sessions": {
        const sessions = await gateway.listSessions();
        return JSON.stringify(
          sessions.map((s) => ({
            id: s.id,
            name: s.name,
            currentCommand: s.currentCommand,
            attached: s.attached,
            lastActivity: s.lastActivity,
          })),
        );
      }
      case "read_screen": {
        if (!args.session_id) return "error: session_id is required";
        const s = await gateway.readScreen(
          args.session_id,
          clampInt(args.history_lines, 0, 0, 2000),
        );
        return JSON.stringify({
          screen: s.screen,
          cursor: s.cursor,
          size: s.size,
          altScreen: s.altScreen,
          currentCommand: s.currentCommand,
        });
      }
      case "wait_idle": {
        if (!args.session_id) return "error: session_id is required";
        const r = await waitIdle(
          args.session_id,
          clampInt(args.timeout_ms, 30000, 1000, 120000),
          clampInt(args.quiet_ms, 2000, 250, 30000),
          signal,
        );
        return JSON.stringify(r);
      }
      case "type_text": {
        if (!args.session_id || !args.text)
          return "error: session_id and text are required";
        await gateway.sendKeys(args.session_id, { text: args.text });
        return "ok: text typed (not executed)";
      }
      case "press_keys": {
        if (!args.session_id || !Array.isArray(args.keys))
          return "error: session_id and keys are required";
        const keys = args.keys.filter((k) =>
          (NAMED_KEYS as readonly string[]).includes(k),
        );
        if (keys.length === 0) return "error: no valid keys";
        await gateway.sendKeys(args.session_id, {
          keys: keys as never,
        });
        return `ok: pressed ${keys.join(" ")}`;
      }
      case "schedule_terminal_action": {
        if (
          !args.session_id ||
          !Array.isArray(args.keys) ||
          typeof args.execute_at !== "string"
        ) {
          return "error: session_id, keys, and execute_at are required";
        }
        const keys = args.keys.filter((key) =>
          (NAMED_KEYS as readonly string[]).includes(key),
        );
        if (keys.length !== args.keys.length || keys.length === 0)
          return "error: no valid keys";
        const action = await gateway.scheduleTerminalAction(
          args.session_id,
          keys,
          args.execute_at,
        );
        return JSON.stringify({ scheduled: true, ...action });
      }
      case "list_scheduled_terminal_actions":
        return JSON.stringify(await gateway.listScheduledTerminalActions());
      case "cancel_scheduled_terminal_action": {
        if (!args.action_id) return "error: action_id is required";
        const action = await gateway.cancelScheduledTerminalAction(
          args.action_id,
        );
        return JSON.stringify({ cancelled: true, ...action });
      }
      case "run_command": {
        if (!args.session_id || !args.command)
          return "error: session_id and command are required";
        await gateway.sendKeys(args.session_id, { text: args.command });
        await gateway.sendKeys(args.session_id, { keys: ["Enter"] });
        const r = await waitIdle(
          args.session_id,
          clampInt(args.timeout_ms, 30000, 1000, 120000),
          2000,
          signal,
        );
        return JSON.stringify(r);
      }
      case "create_session": {
        const r = await gateway.createSession({
          name: args.name,
          cwd: args.cwd,
        });
        return JSON.stringify({ id: r.id, name: r.name });
      }
      case "run_codex": {
        if (!args.session_id || !args.prompt)
          return "error: session_id and prompt are required";
        // Clamp to the two safe modes; anything else -> read-only.
        const mode =
          args.mode === "workspace-write" ? "workspace-write" : "read-only";
        const r = await gateway.runCodex(args.session_id, {
          prompt: args.prompt,
          mode,
        });
        return JSON.stringify({
          mode: r.mode,
          cwd: r.cwd,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          truncated: r.truncated,
          output: r.output,
        });
      }
      case "kanban_list": {
        const boards = await gateway.listKanbanBoards();
        return JSON.stringify(boards);
      }
      case "kanban_get": {
        if (!args.board_id) return "error: board_id is required";
        const b = await gateway.getKanbanBoard(args.board_id);
        return JSON.stringify(b);
      }
      case "kanban_create": {
        if (!args.name) return "error: name is required";
        const b = await gateway.createKanbanBoard({
          name: args.name,
          tags: args.tags ?? [],
          ...(args.columns ? { columns: args.columns } : {}),
        });
        return JSON.stringify(b);
      }
      case "kanban_delete": {
        if (!args.board_id) return "error: board_id is required";
        await gateway.deleteKanbanBoard(args.board_id);
        return `ok: board ${args.board_id} deleted`;
      }
      case "kanban_add_card": {
        if (!args.board_id || !args.title)
          return "error: board_id and title are required";
        const c = await gateway.addKanbanCard(args.board_id, {
          title: args.title,
          description: args.description ?? "",
          tags: args.tags ?? [],
          ...(args.column_id ? { columnId: args.column_id } : {}),
        });
        return JSON.stringify(c);
      }
      case "kanban_update_card": {
        if (!args.board_id || !args.card_id)
          return "error: board_id and card_id are required";
        const c = await gateway.updateKanbanCard(args.board_id, args.card_id, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined
            ? { description: args.description }
            : {}),
          ...(args.tags ? { tags: args.tags } : {}),
        });
        return JSON.stringify(c);
      }
      case "kanban_move": {
        if (
          !args.board_id ||
          !args.card_id ||
          !args.to_column_id ||
          typeof args.to_index !== "number"
        )
          return "error: board_id, card_id, to_column_id and to_index are required";
        // The model does not manage rev: read the board's current rev, move,
        // and on a 409 (stale) retry ONCE using the fresh board the gateway
        // echoed back in the 409 body.
        const board = await gateway.getKanbanBoard(args.board_id);
        const move = { toColumnId: args.to_column_id, toIndex: args.to_index };
        let r = await gateway.moveKanbanCard(args.board_id, args.card_id, {
          ...move,
          rev: board.rev,
        });
        if (r.stale) {
          r = await gateway.moveKanbanCard(args.board_id, args.card_id, {
            ...move,
            rev: r.board.rev,
          });
        }
        if (r.stale)
          return "error: board changed concurrently; refetch and retry";
        return JSON.stringify(r.board);
      }
      case "pm_list_projects": {
        const projects = await gateway.listPmProjects();
        return JSON.stringify(projects);
      }
      case "pm_get_project": {
        if (!args.project_id) return "error: project_id is required";
        const p = await gateway.getPmProject(args.project_id);
        return JSON.stringify(p);
      }
      case "pm_get_tree": {
        if (!args.project_id) return "error: project_id is required";
        const tree = await gateway.getPmTree(args.project_id);
        return JSON.stringify(tree);
      }
      case "pm_create_project": {
        if (!args.name) return "error: name is required";
        const p = await gateway.createPmProject({
          name: args.name,
          tags: args.tags ?? [],
          ...(args.columns ? { columns: args.columns } : {}),
        });
        return JSON.stringify(p);
      }
      case "pm_delete_project": {
        if (!args.project_id) return "error: project_id is required";
        await gateway.deletePmProject(args.project_id);
        return `ok: project ${args.project_id} deleted`;
      }
      case "pm_add_task": {
        if (!args.project_id || !args.title)
          return "error: project_id and title are required";
        const t = await gateway.addPmTask(args.project_id, {
          title: args.title,
          description: args.description ?? "",
          ...(args.type ? { type: args.type as never } : {}),
          ...(args.parent_id !== undefined ? { parentId: args.parent_id } : {}),
          ...(args.assignee != null ? { assignee: args.assignee } : {}),
          ...(args.priority != null
            ? { priority: args.priority as never }
            : {}),
          labels: args.labels ?? [],
          ...(args.start_date !== undefined
            ? { startDate: args.start_date }
            : {}),
          ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
          ...(args.sprint_id !== undefined ? { sprintId: args.sprint_id } : {}),
          ...(args.column_id ? { columnId: args.column_id } : {}),
          ...(args.depends_on ? { dependsOn: args.depends_on } : {}),
        });
        return JSON.stringify(t);
      }
      case "pm_update_task": {
        if (!args.project_id || !args.task_id)
          return "error: project_id and task_id are required";
        // A dependency cycle comes back as 400 {error:"dependency cycle"} and
        // surfaces via the GatewayError catch below — not a crash.
        const t = await gateway.updatePmTask(args.project_id, args.task_id, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined
            ? { description: args.description }
            : {}),
          ...(args.type ? { type: args.type as never } : {}),
          ...(args.parent_id !== undefined ? { parentId: args.parent_id } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
          ...(args.priority !== undefined
            ? { priority: args.priority as never }
            : {}),
          ...(args.labels ? { labels: args.labels } : {}),
          ...(args.start_date !== undefined
            ? { startDate: args.start_date }
            : {}),
          ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
          ...(args.sprint_id !== undefined ? { sprintId: args.sprint_id } : {}),
          ...(args.depends_on ? { dependsOn: args.depends_on } : {}),
        });
        return JSON.stringify(t);
      }
      case "pm_move_task": {
        if (
          !args.project_id ||
          !args.task_id ||
          !args.to_column_id ||
          typeof args.to_index !== "number"
        )
          return "error: project_id, task_id, to_column_id and to_index are required";
        // The model does not manage rev: read the project's current rev, move,
        // and on a 409 (stale) retry ONCE using the fresh project the gateway
        // echoed back in the 409 body.
        const project = await gateway.getPmProject(args.project_id);
        const move = { toColumnId: args.to_column_id, toIndex: args.to_index };
        let r = await gateway.movePmTask(args.project_id, args.task_id, {
          ...move,
          rev: project.rev,
        });
        if (r.stale) {
          r = await gateway.movePmTask(args.project_id, args.task_id, {
            ...move,
            rev: r.project.rev,
          });
        }
        if (r.stale)
          return "error: project changed concurrently; refetch and retry";
        return JSON.stringify(r.project);
      }
      case "pm_add_column": {
        if (!args.project_id || !args.name)
          return "error: project_id and name are required";
        const p = await gateway.createPmColumn(args.project_id, {
          name: args.name,
          ...(args.index !== undefined ? { index: args.index } : {}),
          ...(args.wip_limit !== undefined ? { wipLimit: args.wip_limit } : {}),
          ...(args.transitions !== undefined
            ? { transitions: args.transitions }
            : {}),
        });
        return JSON.stringify(p);
      }
      case "pm_update_column": {
        if (!args.project_id || !args.column_id)
          return "error: project_id and column_id are required";
        const p = await gateway.updatePmColumn(
          args.project_id,
          args.column_id,
          {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.wip_limit !== undefined
              ? { wipLimit: args.wip_limit }
              : {}),
            ...(args.transitions !== undefined
              ? { transitions: args.transitions }
              : {}),
          },
        );
        return JSON.stringify(p);
      }
      case "pm_delete_column": {
        if (!args.project_id || !args.column_id)
          return "error: project_id and column_id are required";
        await gateway.deletePmColumn(args.project_id, args.column_id, {
          mode: args.mode,
          toColumnId: args.to_column_id,
        });
        return `ok: column ${args.column_id} deleted`;
      }
      case "pm_move_column": {
        if (
          !args.project_id ||
          !args.column_id ||
          typeof args.to_index !== "number"
        )
          return "error: project_id, column_id and to_index are required";
        // Auto-manages rev: read current project, move, retry once on 409 stale.
        const project = await gateway.getPmProject(args.project_id);
        let r = await gateway.movePmColumn(args.project_id, args.column_id, {
          toIndex: args.to_index,
          rev: project.rev,
        });
        if (r.stale) {
          r = await gateway.movePmColumn(args.project_id, args.column_id, {
            toIndex: args.to_index,
            rev: r.project.rev,
          });
        }
        if (r.stale)
          return "error: project changed concurrently; refetch and retry";
        return JSON.stringify(r.project);
      }
      case "pm_add_sprint": {
        if (!args.project_id || !args.name)
          return "error: project_id and name are required";
        const s = await gateway.addPmSprint(args.project_id, {
          name: args.name,
          ...(args.start_date !== undefined
            ? { startDate: args.start_date }
            : {}),
          ...(args.end_date !== undefined ? { endDate: args.end_date } : {}),
        });
        return JSON.stringify(s);
      }
      // --- PM Collaboration (Phase 3) ----------------------------------------
      case "pm_add_comment": {
        if (!args.project_id || !args.task_id || !args.body)
          return "error: project_id, task_id and body are required";
        const comment = await gateway.addPmComment(
          args.project_id,
          args.task_id,
          { body: args.body },
        );
        return JSON.stringify(comment);
      }
      case "pm_list_comments": {
        if (!args.project_id || !args.task_id)
          return "error: project_id and task_id are required";
        const comments = await gateway.listPmComments(
          args.project_id,
          args.task_id,
        );
        return JSON.stringify(comments);
      }
      case "pm_list_activity": {
        if (!args.project_id) return "error: project_id is required";
        const activity = await gateway.listPmActivity(args.project_id, {
          limit: args.limit,
          before: args.before,
        });
        return JSON.stringify(activity);
      }
      case "pm_watch_task": {
        if (!args.project_id || !args.task_id)
          return "error: project_id and task_id are required";
        const watched = await gateway.watchPmTask(
          args.project_id,
          args.task_id,
        );
        return JSON.stringify(watched);
      }
      case "pm_unwatch_task": {
        if (!args.project_id || !args.task_id)
          return "error: project_id and task_id are required";
        const unwatched = await gateway.unwatchPmTask(
          args.project_id,
          args.task_id,
        );
        return JSON.stringify(unwatched);
      }
      case "pm_list_attachments": {
        if (!args.project_id || !args.task_id)
          return "error: project_id and task_id are required";
        const attachments = await gateway.listPmAttachments(
          args.project_id,
          args.task_id,
        );
        return JSON.stringify(attachments);
      }
      default:
        return `error: unknown tool ${tool}`;
    }
  } catch (err) {
    if (err instanceof GatewayError) {
      return `error: gateway ${err.status}: ${err.message}`;
    }
    if (err instanceof Error && err.name === "AbortError") throw err;
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
