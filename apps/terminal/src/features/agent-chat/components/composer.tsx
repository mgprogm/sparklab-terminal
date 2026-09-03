"use client";

/**
 * Composer: a single unified input box — an auto-growing textarea over a slim
 * footer holding the target-picker chip (left) and send/stop (right). The
 * target defaults to "Auto" (the focused terminal); picking a session pins it.
 * Enter sends, Shift+Enter inserts a newline. While the agent is working the
 * send button becomes a Stop that interrupts the turn.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import { cn } from "@sparklab/ui/lib/utils";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Mic,
  MicOff,
  Pin,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAgentStore } from "../store";

import type {
  AgentModel,
  AgentReasoningEffort,
  SessionInfo,
} from "@sparklab/shared-types";

const MODEL_LABELS: Record<AgentModel, string> = {
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
  "gpt-5.6-luna": "Luna",
  "deepseek-v4-pro-byteplus": "DeepSeek V4 Pro",
  "deepseek-v32-byteplus": "DeepSeek V3.2",
  "glm-byteplus": "GLM-4.7",
  "codex-cli": "Codex CLI",
};

/** Provider shown under the model name in the picker. */
const MODEL_PROVIDER: Record<AgentModel, string> = {
  "gpt-5.6-sol": "Azure",
  "gpt-5.6-terra": "Azure",
  "gpt-5.6-luna": "Azure",
  "deepseek-v4-pro-byteplus": "BytePlus Ark",
  "deepseek-v32-byteplus": "BytePlus Ark",
  "glm-byteplus": "BytePlus Ark",
  "codex-cli": "OpenAI Codex",
};

/**
 * Reasoning effort is a GPT-5.6 control; BytePlus Ark models ignore it, and
 * "Codex CLI" is not a chat-completions model at all.
 */
const modelSupportsEffort = (model: AgentModel): boolean =>
  !model.endsWith("-byteplus") && model !== "codex-cli";

const EFFORT_LABELS: Record<AgentReasoningEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const WAVEFORM_DELAYS_MS = [0, 90, 180, 270, 360, 450, 540, 630, 720, 810];

export function Composer({
  sessions,
  activeSessionId,
  disabled = false,
  onSend,
  onStop,
}: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  disabled?: boolean;
  onSend: (
    text: string,
    targetSessionId?: string,
    model?: AgentModel,
    reasoningEffort?: AgentReasoningEffort,
  ) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recognizerRef = useRef<{
    stopContinuousRecognitionAsync: (
      onSuccess: () => void,
      onError?: (error: string) => void,
    ) => void;
    close: () => void;
  } | null>(null);
  const status = useAgentStore((s) => s.status);
  const pinnedTargetId = useAgentStore((s) => s.pinnedTargetId);
  const setPinnedTargetId = useAgentStore((s) => s.setPinnedTargetId);
  const model = useAgentStore((s) => s.model);
  const setModel = useAgentStore((s) => s.setModel);
  const reasoningEffort = useAgentStore((s) => s.reasoningEffort);
  const setReasoningEffort = useAgentStore((s) => s.setReasoningEffort);
  const availableModels = useAgentStore((s) => s.availableModels);
  const availableReasoningEfforts = useAgentStore(
    (s) => s.availableReasoningEfforts,
  );

  const working = status !== "idle";
  const effectiveTarget = pinnedTargetId ?? activeSessionId;
  const targetName =
    sessions.find((s) => s.id === effectiveTarget)?.name ?? "no session";

  // Auto-grow: reset then clamp to ~6 rows. Only show the scrollbar once the
  // content actually exceeds the clamp, otherwise a sub-pixel scrollHeight
  // rounding leaves an unwanted scrollbar on a single empty line.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 132);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > 132 ? "auto" : "hidden";
  }, [text, interimText]);

  const stopListening = () => {
    const recognizer = recognizerRef.current;
    recognizerRef.current = null;
    setListening(false);
    setInterimText("");
    if (!recognizer) return;
    recognizer.stopContinuousRecognitionAsync(
      () => recognizer.close(),
      () => recognizer.close(),
    );
  };

  useEffect(() => () => stopListening(), []);

  const appendTranscript = (transcript: string) => {
    setText((current) => {
      const prefix = current.trimEnd();
      return prefix ? `${prefix} ${transcript}` : transcript;
    });
  };

  const startListening = async () => {
    if (disabled || working || listening) return;
    setSpeechError(null);

    try {
      const tokenResponse = await fetch("/api/speech/token", {
        method: "POST",
      });
      const tokenBody: unknown = await tokenResponse.json();
      const maybeSpeechToken =
        tokenBody && typeof tokenBody === "object"
          ? (tokenBody as Partial<{ token: string; region: string }>)
          : null;
      if (
        !tokenResponse.ok ||
        !maybeSpeechToken ||
        typeof maybeSpeechToken.token !== "string" ||
        typeof maybeSpeechToken.region !== "string"
      ) {
        throw new Error("Speech recognition is unavailable");
      }
      const speechToken = maybeSpeechToken as { token: string; region: string };

      const SpeechSDK = await import("microsoft-cognitiveservices-speech-sdk");
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        speechToken.token,
        speechToken.region,
      );
      speechConfig.speechRecognitionLanguage = navigator.language || "en-US";
      const recognizer = new SpeechSDK.SpeechRecognizer(
        speechConfig,
        SpeechSDK.AudioConfig.fromDefaultMicrophoneInput(),
      );

      recognizerRef.current = recognizer;
      recognizer.recognizing = (_, event) => setInterimText(event.result.text);
      recognizer.recognized = (_, event) => {
        if (event.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
          appendTranscript(event.result.text);
        }
        setInterimText("");
      };
      recognizer.canceled = (_, event) => {
        if (event.reason === SpeechSDK.CancellationReason.Error) {
          setSpeechError("Speech recognition stopped unexpectedly");
        }
        stopListening();
      };
      recognizer.sessionStopped = () => stopListening();
      recognizer.startContinuousRecognitionAsync(
        () => setListening(true),
        () => {
          setSpeechError("Could not access the microphone");
          stopListening();
        },
      );
    } catch {
      setSpeechError("Speech recognition is unavailable");
      stopListening();
    }
  };

  const submit = () => {
    const t = text.trim();
    if (!t || working || disabled) return;
    onSend(t, effectiveTarget ?? undefined, model, reasoningEffort);
    setText("");
  };

  return (
    <div className="border-border border-t px-3 py-2.5">
      <div className="bg-secondary border-border focus-within:border-ring/60 flex flex-col rounded-md border transition-colors">
        <textarea
          ref={taRef}
          rows={1}
          value={
            interimText
              ? `${text}${text.trimEnd() ? " " : ""}${interimText}`
              : text
          }
          disabled={disabled || listening}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled ? "Waiting for terminal chat…" : "Ask the agent…"
          }
          className="text-foreground placeholder:text-muted-foreground max-h-[132px] min-h-8 resize-none bg-transparent px-3 pb-1 pt-2 text-base leading-relaxed outline-none sm:text-sm"
        />

        {listening && (
          <div
            role="status"
            aria-live="polite"
            className="border-border/60 flex h-8 items-center gap-2 border-t px-3"
          >
            <span className="text-destructive shrink-0 text-xs font-medium">
              Listening
            </span>
            <div
              aria-hidden="true"
              className="flex h-4 flex-1 items-center justify-center gap-1"
            >
              {WAVEFORM_DELAYS_MS.map((delay) => (
                <span
                  key={delay}
                  className="voice-wave-bar bg-destructive/80 w-0.5 rounded-full"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">
              Tap mic to stop
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-xs transition-colors"
                >
                  {pinnedTargetId ? (
                    <Pin className="text-chart-2 size-3 shrink-0" />
                  ) : (
                    <span>Auto ·</span>
                  )}
                  <span className="max-w-24 truncate">{targetName}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuItem onClick={() => setPinnedTargetId(null)}>
                  <span className="text-muted-foreground">
                    Auto (follow focused terminal)
                  </span>
                </DropdownMenuItem>
                {sessions.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setPinnedTargetId(s.id)}
                  >
                    <span className="bg-chart-1 size-[6px] rounded-full" />
                    <span className="truncate">{s.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={working || disabled}
                  aria-label="Choose agent model and reasoning effort"
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
                >
                  <SlidersHorizontal className="size-3 shrink-0" />
                  <span>
                    {MODEL_LABELS[model]}
                    {modelSupportsEffort(model)
                      ? ` · ${EFFORT_LABELS[reasoningEffort]}`
                      : ""}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuLabel>Model</DropdownMenuLabel>
                {availableModels.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onClick={() => setModel(option)}
                  >
                    <span className="flex flex-col">
                      <span>{MODEL_LABELS[option]}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {MODEL_PROVIDER[option]}
                      </span>
                    </span>
                    {model === option && (
                      <Check className="ml-auto size-3.5 self-center" />
                    )}
                  </DropdownMenuItem>
                ))}
                {modelSupportsEffort(model) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
                    {availableReasoningEfforts.map((option) => (
                      <DropdownMenuItem
                        key={option}
                        onClick={() => setReasoningEffort(option)}
                      >
                        <span>{EFFORT_LABELS[option]}</span>
                        {reasoningEffort === option && (
                          <Check className="ml-auto size-3.5" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center gap-1">
            {speechError && (
              <span className="text-destructive max-w-28 truncate text-xs">
                {speechError}
              </span>
            )}
            <button
              type="button"
              onClick={listening ? stopListening : () => void startListening()}
              disabled={disabled || working}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              aria-pressed={listening}
              title={listening ? "Stop voice input" : "Start voice input"}
              className={cn(
                "text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-sm transition-colors disabled:pointer-events-none disabled:opacity-40",
                listening && "bg-destructive/10 text-destructive",
              )}
            >
              {listening ? (
                <MicOff className="size-4" />
              ) : (
                <Mic className="size-4" />
              )}
            </button>
            {working ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop the agent"
                className="border-chart-2/50 text-chart-2 hover:bg-chart-2/10 flex size-7 shrink-0 items-center justify-center rounded-sm border transition-colors"
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim() || disabled}
                aria-label="Send"
                className={cn(
                  "bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity",
                  (!text.trim() || disabled) && "opacity-40",
                )}
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
