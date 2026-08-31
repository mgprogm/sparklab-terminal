"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sparklab/ui/components/ui/alert-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Globe2,
  Loader2,
  MousePointer2,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useBrowserViewStore } from "../store";

import {
  cancelBrowserHandoff,
  finishBrowserHandoff,
  requestBrowserHandoff,
  useAgentStore,
} from "@/features/agent-chat";
import {
  BrowserHandoffConnection,
  InteractiveBrowser,
  useBrowserHandoffStore,
} from "@/features/browser-handoff";

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "Browser page";
  }
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

export function BrowserViewOverlay() {
  const view = useBrowserViewStore((state) => state.view);
  const visible = useBrowserViewStore((state) => state.visible);
  const hide = useBrowserViewStore((state) => state.hide);
  const agentStatus = useAgentStore((state) => state.status);
  const agentConnected = useAgentStore((state) => state.connected);
  const handoffState = useBrowserHandoffStore((state) => state.state);
  const handoffId = useBrowserHandoffStore((state) => state.handoffId);
  const handoffToken = useBrowserHandoffStore((state) => state.token);
  const handoffResume = useBrowserHandoffStore((state) => state.resume);
  const connectionState = useBrowserHandoffStore(
    (state) => state.connectionState,
  );
  const idleExpiresAt = useBrowserHandoffStore((state) => state.idleExpiresAt);
  const hardExpiresAt = useBrowserHandoffStore((state) => state.hardExpiresAt);
  const transport = useBrowserHandoffStore((state) => state.transport);
  const transportState = useBrowserHandoffStore(
    (state) => state.transportState,
  );
  const transportReason = useBrowserHandoffStore(
    (state) => state.transportReason,
  );
  const [connection, setConnection] = useState<BrowserHandoffConnection | null>(
    null,
  );
  const [takeoverWarningOpen, setTakeoverWarningOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (view && visible && handoffState !== "human_active")
      backRef.current?.focus();
  }, [view, visible, handoffState]);

  useEffect(() => {
    if (!handoffId) {
      setConnection(null);
      return;
    }
    const token = useBrowserHandoffStore.getState().token;
    if (!token) return;
    const next = new BrowserHandoffConnection(
      { handoffId, token, resume: handoffResume },
      {
        onConnectionState: useBrowserHandoffStore.getState().setConnectionState,
        onAuthenticated: useBrowserHandoffStore.getState().consumeToken,
        onExpiry: useBrowserHandoffStore.getState().updateExpiry,
        onTransportState: useBrowserHandoffStore.getState().setTransportState,
        onMediaStream: setMediaStream,
      },
    );
    setConnection(next);
    next.connect();
    return () => {
      setMediaStream(null);
      next.dispose();
    };
    // `token` is deliberately excluded: onAuthenticated (consumeToken) nulls it
    // the moment the socket authenticates, as a one-time-credential safeguard.
    // Depending on it here would re-run this effect right after a successful
    // connect and dispose() the very socket that just authenticated, leaving
    // `connection` pointing at a dead BrowserHandoffConnection forever (the
    // "take control" screen goes solid white with no frames and no visible
    // error). The token is read once via getState() above instead.
  }, [handoffId, handoffResume]);

  useEffect(() => {
    if (handoffState !== "human_active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [handoffState]);

  const countdown = useMemo(() => {
    const idle = idleExpiresAt ? idleExpiresAt - now : null;
    const hard = hardExpiresAt ? hardExpiresAt - now : null;
    return {
      idle,
      hard,
      warning:
        (idle !== null && idle <= 60_000) || (hard !== null && hard <= 60_000),
    };
  }, [hardExpiresAt, idleExpiresAt, now]);

  const humanActive = handoffState === "human_active";
  const pending = handoffState === "pending";
  const closed = handoffState === "closed";
  const activeHandoff = (humanActive || pending) && Boolean(handoffId);
  if ((!view || !visible) && !activeHandoff) return null;

  const imageUrl = view
    ? `data:${view.screenshot.mediaType};base64,${view.screenshot.data}`
    : null;
  const credentialsUnavailable = !view && !connection && !handoffToken;
  const takeControlEnabled =
    Boolean(view) &&
    agentConnected &&
    agentStatus === "idle" &&
    handoffState !== "closed";

  return (
    <section
      className="bg-background absolute inset-0 z-20 flex min-h-0 flex-col"
      aria-label="Browser view"
    >
      <div className="border-border flex min-h-[50px] shrink-0 items-center gap-2 border-b px-3">
        <Globe2 className="text-chart-2 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-xs font-medium">
            {view?.title || "Browser handoff"}
          </div>
          <div className="text-muted-foreground truncate text-[10px]">
            {view
              ? safeDisplayUrl(view.url)
              : "Recovery controls for the active session"}
          </div>
        </div>

        {!humanActive && !pending && !closed && (
          <button
            type="button"
            disabled={!takeControlEnabled}
            title={
              takeControlEnabled
                ? "Interact with this isolated browser"
                : "Wait until the agent is idle"
            }
            onClick={() => setTakeoverWarningOpen(true)}
            className="border-border bg-card text-secondary-foreground hover:bg-accent flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <MousePointer2 className="size-3.5" />
            Take control
          </button>
        )}

        {(humanActive || pending) && handoffId && (
          <>
            {humanActive && (
              <button
                type="button"
                onClick={() => finishBrowserHandoff(handoffId)}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
              >
                <Check className="size-3.5" />
                Done — return to agent
              </button>
            )}
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-red-500/50 px-2 text-xs text-red-600 hover:bg-red-500/10"
            >
              <Trash2 className="size-3.5" />
              Cancel browser session
            </button>
          </>
        )}

        {!humanActive && (
          <button
            ref={backRef}
            type="button"
            onClick={hide}
            className="border-border bg-card text-secondary-foreground hover:bg-accent flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to terminal
          </button>
        )}
      </div>

      {humanActive && (
        <div
          className={`flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs ${countdown.warning ? "bg-red-600 text-white" : "bg-amber-400 text-amber-950"}`}
          role="status"
        >
          <strong>Agent paused — you control this browser</strong>
          {countdown.idle !== null && (
            <span>Idle timeout {formatRemaining(countdown.idle)}</span>
          )}
          {countdown.hard !== null && (
            <span>Hard limit {formatRemaining(countdown.hard)}</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <span title={transportReason ?? undefined}>
              {transport === "webrtc" && transportState === "connected"
                ? "WebRTC video"
                : transportState === "negotiating"
                  ? "Negotiating WebRTC"
                  : transportState === "fallback"
                    ? "JPEG fallback"
                    : "JPEG stream"}
            </span>
            <span aria-hidden="true">·</span>
            {credentialsUnavailable ? (
              <>
                <Unplug className="size-3" /> Recovery controls only
              </>
            ) : connectionState === "connected" ? (
              <>Connected</>
            ) : connectionState === "reconnecting" ? (
              <>
                <Loader2 className="size-3 animate-spin" /> Reconnecting — agent
                remains paused
              </>
            ) : connectionState === "closed" ? (
              <>
                <Unplug className="size-3" /> Connection lost — browser session
                closing
              </>
            ) : (
              <>
                <Loader2 className="size-3 animate-spin" /> Connecting
              </>
            )}
          </span>
        </div>
      )}

      <div className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        {humanActive && credentialsUnavailable ? (
          <div className="flex max-w-md flex-col items-center gap-2 text-center">
            <Unplug className="text-muted-foreground size-7" />
            <p className="text-foreground text-sm font-medium">
              Interactive control is unavailable after reload
            </p>
            <p className="text-muted-foreground text-xs">
              The private browser session is still active. Select Done to return
              control to the agent, or Cancel to close the browser.
            </p>
          </div>
        ) : humanActive ? (
          <InteractiveBrowser
            connection={connection}
            enabled={connectionState === "connected"}
            mediaStream={mediaStream}
          />
        ) : pending && credentialsUnavailable ? (
          <div className="flex max-w-md flex-col items-center gap-2 text-center">
            <Unplug className="text-muted-foreground size-7" />
            <p className="text-foreground text-sm font-medium">
              Interactive setup is unavailable after reload
            </p>
            <p className="text-muted-foreground text-xs">
              Cancel this browser session, then ask the agent to start a new
              handoff.
            </p>
          </div>
        ) : pending ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Securing interactive
            control…
          </div>
        ) : closed ? (
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <Unplug className="text-muted-foreground size-7" />
            <p className="text-foreground text-sm font-medium">
              Browser session closed
            </p>
            <p className="text-muted-foreground text-xs">
              Its temporary cookies and login state are no longer available.
            </p>
          </div>
        ) : view && imageUrl ? (
          <button
            type="button"
            disabled={!takeControlEnabled}
            onClick={() => setTakeoverWarningOpen(true)}
            className="group relative flex max-h-full max-w-full cursor-pointer items-center justify-center disabled:cursor-not-allowed"
            aria-label="Take control of this browser"
          >
            <img
              src={imageUrl}
              alt={`Read-only browser snapshot of ${view.title || "the current page"}`}
              width={view.viewport.width}
              height={view.viewport.height}
              className="max-h-full max-w-full object-contain shadow-lg transition group-hover:brightness-75"
            />
            <span className="bg-background/90 text-foreground border-border absolute left-1/2 top-3 -translate-x-1/2 rounded-md border px-3 py-2 text-sm font-medium shadow-lg backdrop-blur-sm">
              <MousePointer2 className="mr-1.5 inline size-4" />
              {takeControlEnabled
                ? "Take control"
                : "Wait for the agent to become idle"}
            </span>
          </button>
        ) : null}
      </div>

      {!humanActive && !pending && !closed && (
        <div className="border-border text-muted-foreground flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[11px]">
          <RefreshCw className="size-3" /> Read-only snapshot · Updated revision{" "}
          {view?.revision}
        </div>
      )}

      <AlertDialog
        open={takeoverWarningOpen}
        onOpenChange={setTakeoverWarningOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Take control of isolated browser?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This is an isolated browser. Existing logins and cookies from your
              personal browser are not shared. Sign in again only if you trust
              this session. Clipboard, paste, file upload, and drag-and-drop are
              disabled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => view && requestBrowserHandoff(view.browserId)}
            >
              Take control
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-600" /> Cancel browser
              session?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This destroys the isolated browser, including its temporary
              cookies and login state. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep session</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => handoffId && cancelBrowserHandoff(handoffId)}
            >
              Destroy browser session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
