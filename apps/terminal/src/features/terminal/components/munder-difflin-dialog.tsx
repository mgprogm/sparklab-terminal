"use client";

/**
 * MunderDifflinDialog — a thin host seam, structured exactly like
 * KanbanDialog: the body is a single same-origin `<iframe>` pointed at
 * `/munder-difflin/app.html`. That document nests a further iframe at the
 * GATEWAY's own `/api/munder-difflin/vnc.html` — a reverse proxy in front of
 * the noVNC/websockify bridge for the headless munder-difflin Electron app
 * (Xvfb + x11vnc + websockify; see the run-desktop skill in
 * ~/workspaces/sparklab/munder-difflin), rather than hitting that bridge's
 * own port directly. Swap the file behind the iframe and you swap the
 * artifact, same as Kanban/PM.
 *
 * Why go through the gateway instead of the bridge's raw port: the bridge has
 * no auth of its own (anyone who could reach it could view AND control the
 * app), and a hardcoded `host:6080` never works over the loclx tunnel (only
 * the single proxied origin is tunneled). Routing through the gateway reuses
 * its existing cookie auth/origin allowlist and rides the same origin as
 * everything else in prod. The gateway URL is passed to app.html via a query
 * param (same env var + same reasoning as connection.ts's WS URL: in dev,
 * Next's rewrites can't proxy a WS upgrade, so the client must dial the
 * gateway's own port directly; the `gw_session` cookie still reaches it
 * because cookies aren't port-scoped — same hostname is enough. In prod the
 * gateway origin already equals the app's origin.)
 *
 * Sandbox flags mirror KanbanDialog's rationale (DOM/CSS/JS isolation, not a
 * security boundary — same-origin first-party content either way). Because
 * sandboxing flags apply recursively to nested browsing contexts, the same
 * flag set also governs the inner noVNC frame: `allow-scripts` lets noVNC's
 * own JS (canvas rendering, WebSocket) run.
 *
 * Munder Difflin is gateway-global like Kanban/PM/Agentic (not session- or
 * server-scoped) — the dialog needs no session or server props.
 *
 * Sizing deliberately deviates from the other artifact dialogs' shared
 * `h-[85vh] sm:max-w-6xl` — this one is a live remote-desktop view (the
 * virtual display is 1920x1080), not text/form content, so it's sized to
 * near-fill the viewport (`95vh`/`95vw`) rather than capped at a reading-width
 * `max-w-6xl`, which would otherwise force the whole VNC frame to scale down
 * far more than necessary. Both the base `max-w-[95vw]` and the `sm:`-prefixed
 * copy are needed — DialogContent's default `sm:max-w-lg` lives in a separate
 * Tailwind variant group from an unprefixed override, so `twMerge` won't drop
 * it just because a base `max-w-*` was supplied; without the explicit `sm:`
 * override, `sm:max-w-lg` (32rem) wins at desktop widths and the dialog stays
 * small regardless of the base class.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { AppWindow } from "lucide-react";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3007";

export function MunderDifflinDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[95vh] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[95vw]">
        <DialogHeader className="border-border gap-1.5 border-b px-4 py-3 text-left">
          <div className="flex items-center gap-2">
            <AppWindow className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">
              Munder Difflin
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Live view of the munder-difflin Electron app, streamed over noVNC
            through the gateway's reverse proxy.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src={`/munder-difflin/app.html?gateway=${encodeURIComponent(GATEWAY_URL)}`}
          title="Munder Difflin viewer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
