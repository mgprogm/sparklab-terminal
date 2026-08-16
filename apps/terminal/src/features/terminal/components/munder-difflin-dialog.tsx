"use client";

/**
 * MunderDifflinDialog — a thin host seam, structured exactly like
 * KanbanDialog: the body is a single same-origin `<iframe>` pointed at
 * `/munder-difflin/app.html`. That document nests a further iframe at the
 * GATEWAY's own `/api/munder-difflin/vnc.html` for the headless munder-difflin
 * Electron app (Xvfb + x11vnc; see the run-desktop skill in
 * ~/workspaces/sparklab/munder-difflin). The gateway serves noVNC's static
 * client straight off disk and terminates the VNC WebSocket itself, relaying
 * raw bytes to x11vnc's RFB TCP port directly — no `websockify` process
 * involved (see server.js's `serveMunderDifflinStatic` + `munderDifflinWss`).
 * Swap the file behind the iframe and you swap the artifact, same as
 * Kanban/PM.
 *
 * Why go through the gateway instead of x11vnc's raw port: x11vnc has no auth
 * of its own (anyone who could reach it could view AND control the app), and
 * a hardcoded `host:6080` never worked over the loclx tunnel (only the single
 * proxied origin is tunneled). Routing through the gateway reuses its
 * existing cookie auth/origin allowlist and rides the same origin as
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
 * own JS (RFB protocol, canvas rendering, WebSocket) run.
 *
 * Munder Difflin is gateway-global like Kanban/PM/Agentic (not session- or
 * server-scoped) — the dialog needs no session or server props.
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
      <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
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
