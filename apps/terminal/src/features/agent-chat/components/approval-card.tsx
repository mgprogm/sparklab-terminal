"use client";

/**
 * Inline approval card — the only elevated element in the stream. Shows the
 * target session, the exact keystrokes/command (control chars visualized), and
 * client-side risk hints. Approve is the off-white CTA unless a destructive
 * hint fires, in which case it turns destructive with a short arming delay.
 */
import { useEffect, useRef, useState } from "react";
import { Keyboard, TriangleAlert } from "lucide-react";
import { Button } from "@sparklab/ui/components/ui/button";
import { cn } from "@sparklab/ui/lib/utils";
import type { AgentApprovalBehavior } from "@sparklab/shared-types";
import { visualizeKeys } from "../tool-meta";
import type { ApprovalEntry } from "../types";

interface Input {
  text?: string;
  command?: string;
  keys?: string[];
  name?: string;
}

function keystrokeParts(tool: string, input: Input): string[] {
  if (tool === "type_text" && input.text) return [input.text];
  if (tool === "run_command" && input.command) return [input.command, "Enter"];
  if (tool === "press_keys" && Array.isArray(input.keys)) return input.keys;
  if (tool === "create_session")
    return [`new session${input.name ? ` "${input.name}"` : ""}`];
  return [];
}

function riskHints(tool: string, input: Input): string[] {
  const hints: string[] = [];
  const cmd = `${input.text ?? ""} ${input.command ?? ""}`;
  if (/\brm\s+-rf?\b/.test(cmd)) hints.push("Contains rm -rf");
  if (/\bsudo\b/.test(cmd)) hints.push("Runs as root (sudo)");
  if (/\|\s*(sudo\s+)?(sh|bash)\b/.test(cmd)) hints.push("Pipes to a shell");
  if (tool === "run_command") hints.push("Runs immediately (includes Enter)");
  if (
    (tool === "press_keys" && input.keys?.includes("Enter")) ||
    (tool === "press_keys" && input.keys?.some((k) => k.startsWith("C-")))
  )
    hints.push("Sends a control key to the running process");
  return hints;
}

const DESTRUCTIVE = /rm\s+-rf?|sudo|\|\s*(sh|bash)/;

export function ApprovalCard({
  entry,
  sessionName,
  onRespond,
}: {
  entry: ApprovalEntry;
  sessionName?: string;
  onRespond: (behavior: AgentApprovalBehavior) => void;
}) {
  const [always, setAlways] = useState(false);
  const [armed, setArmed] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const input = (entry.input ?? {}) as Input;

  const parts = keystrokeParts(entry.tool, input);
  const hints = riskHints(entry.tool, input);
  const dangerous = DESTRUCTIVE.test(
    `${input.text ?? ""} ${input.command ?? ""}`,
  );

  // Arm destructive approvals only after 400ms to prevent reflex clicks.
  useEffect(() => {
    if (!dangerous) return;
    setArmed(false);
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, [dangerous]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const approve = () => onRespond(always ? "allow_always" : "allow");
  const deny = () => onRespond("deny");

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label="Approval needed"
      onKeyDown={(e) => {
        if (e.key === "Enter" && armed) {
          e.preventDefault();
          approve();
        } else if (e.key === "Escape") {
          e.preventDefault();
          deny();
        }
      }}
      className="border-chart-2/40 bg-card flex flex-col gap-2 rounded-md border p-3 outline-none"
    >
      <div className="text-chart-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider">
        <Keyboard className="size-3.5" />
        Approval needed
      </div>

      <div className="text-body flex items-center gap-1.5 text-xs">
        {entry.tool === "create_session" ? "create" : "type into"}
        {sessionName && (
          <span className="bg-secondary text-foreground rounded-xs flex items-center gap-1 px-1.5 py-0.5">
            <span className="bg-chart-1 size-[5px] rounded-full" />
            {sessionName}
          </span>
        )}
      </div>

      {parts.length > 0 && (
        <div className="bg-secondary/60 rounded-sm p-2 font-mono text-xs leading-relaxed">
          {parts.map((p, i) => (
            <span key={i}>
              {visualizeKeys(p).map((seg, j) => (
                <span
                  key={j}
                  className={seg.control ? "text-chart-2" : "text-foreground"}
                >
                  {seg.text}
                </span>
              ))}
              {i < parts.length - 1 && " "}
            </span>
          ))}
        </div>
      )}

      {hints.length > 0 && (
        <div className="flex flex-col gap-1">
          {hints.map((h, i) => (
            <div
              key={i}
              className="text-destructive flex items-center gap-1.5 text-[11px]"
            >
              <TriangleAlert className="size-3.5 shrink-0" />
              {h}
            </div>
          ))}
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-2">
        <Button
          size="sm"
          variant={dangerous ? "destructive" : "default"}
          disabled={!armed}
          onClick={approve}
          className="h-7 text-xs"
        >
          Approve ⏎
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={deny}
          className="h-7 text-xs"
        >
          Deny
        </Button>
      </div>

      <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          className={cn("accent-chart-2 rounded-xs size-3")}
        />
        Auto-approve{" "}
        {entry.tool === "create_session" ? "creating sessions" : "typing"}
        {sessionName ? ` in ${sessionName}` : ""} this session
      </label>
    </div>
  );
}
