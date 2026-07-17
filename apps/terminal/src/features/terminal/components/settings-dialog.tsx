"use client";

/**
 * Settings modal — a read-mostly preferences panel opened from the sidebar's
 * account row (gear icon). Four tabbed sections: Appearance (the only one with
 * real behavior — a persisted terminal font-size preference wired into XTerm),
 * Agent chat (informational: fixed model + approval policy), Account (identity
 * + sign out, or an "auth disabled" note in open mode), and Connection
 * (read-only gateway URL, live status, active session count).
 *
 * The active tab lives in the terminal store (`settingsSection`) so it can be
 * deep-linked via `?settings=<section>` (see use-settings-url-sync).
 *
 * Styling mirrors chat-history-dialog.tsx: DESIGN.md theme tokens only
 * (border-border / text-muted-foreground / bg-accent / text-foreground), no
 * hardcoded hex, lucide-react icons at size-3.5/size-4, @sparklab/ui primitives.
 */

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
import { Button } from "@sparklab/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { cn } from "@sparklab/ui/lib/utils";
import {
  Bell,
  BellOff,
  Bot,
  CircleUser,
  Loader2,
  LogOut,
  Plug,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  Type,
  Unplug,
} from "lucide-react";
import { useState } from "react";

import {
  usePushNotifications,
  usePushSettings,
} from "../hooks/use-push-notifications";
import { useServers, useDeleteServer } from "../hooks/use-servers";
import {
  isServerUnreachable,
  serverDotClass,
  serverStatus,
} from "../server-grouping";
import {
  useTerminalStore,
  type SettingsSection,
  type TerminalFontSize,
} from "../store";
import { AddServerDialog } from "./add-server-dialog";

import type { ConnectionStatus } from "../connection";
import type { ServerInfo } from "@sparklab/shared-types";
import type { ComponentType, ReactNode } from "react";

// Gateway URL: same env + fallback the WS Connection uses (connection.ts).
const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3007";

// The agent model is fixed server-side (Azure OpenAI); shown read-only here.
const AGENT_MODEL = "gpt-5.6-sol";

// Font-size choices offered in the UI. "auto" keeps the responsive 13/14
// default; the numbers straddle it (14 is the wide-screen default).
const FONT_SIZE_OPTIONS: { label: string; value: TerminalFontSize }[] = [
  { label: "Auto", value: "auto" },
  { label: "12", value: 12 },
  { label: "14", value: 14 },
  { label: "16", value: 16 },
  { label: "18", value: 18 },
];

/** Tab definitions — order matches SETTINGS_SECTIONS (the URL/tab order). */
const TABS: {
  key: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { key: "appearance", label: "Appearance", icon: Type },
  { key: "notifications", label: "Notify", icon: Bell },
  { key: "agent", label: "Agent", icon: Bot },
  { key: "account", label: "Account", icon: CircleUser },
  { key: "connection", label: "Connection", icon: Plug },
  { key: "servers", label: "Servers", icon: Server },
];

/** Body wrapper for one section (the active tab). */
function Section({ children }: { children: ReactNode }) {
  return <section className="px-4 py-3.5">{children}</section>;
}

/** The "unreachable" text chip reused across server surfaces (§3.3). */
function UnreachableChip() {
  return (
    <span className="text-muted-foreground border-border inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wider">
      <Unplug className="size-3" />
      unreachable
    </span>
  );
}

/** Servers settings section — list registry servers, add, and remove. Its own
 *  component so `useServers()` only runs when this tab is open (existing
 *  settings tests render without a QueryClientProvider). */
function ServersSection({ onDialogClose }: { onDialogClose?: () => void }) {
  const {
    data: servers,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useServers();
  const deleteServer = useDeleteServer();
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ServerInfo | null>(null);

  const sshServers = (servers ?? []).filter((s) => s.type !== "local");

  return (
    <Section>
      <div className="flex items-center justify-between">
        <span className="text-foreground text-sm">Servers</span>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" />
          Add server
        </Button>
      </div>

      <div className="border-border divide-border mt-2 divide-y border-t">
        {isLoading && (
          <p className="text-muted-foreground flex items-center gap-2 py-3 text-sm">
            <Loader2 className="size-3.5 animate-spin" />
            Loading servers…
          </p>
        )}
        {isError && !isLoading && (
          <div className="flex items-center gap-2 py-3">
            <span className="text-muted-foreground text-sm">
              Couldn&apos;t load servers.
            </span>
            {/* isFetching (not isLoading) is what's true during a background
                retry — react-query keeps the stale error data meanwhile. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching && <Loader2 className="size-3.5 animate-spin" />}
              {isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        )}
        {!isLoading &&
          !isError &&
          (servers ?? []).map((s) => {
            const unreachable = isServerUnreachable(s);
            const detail =
              s.type === "local"
                ? "local"
                : `${s.user ? `${s.user}@` : ""}${s.host ?? ""}${
                    s.port && s.port !== 22 ? `:${String(s.port)}` : ""
                  }`;
            return (
              <div
                key={s.id}
                className="flex items-center justify-between gap-3 py-1.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-[7px] shrink-0 rounded-full",
                      serverDotClass(s),
                    )}
                    title={serverStatus(s)}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm">
                        {s.name}
                      </span>
                      {unreachable && <UnreachableChip />}
                    </div>
                    <span className="text-muted-foreground block truncate text-xs">
                      {detail}
                    </span>
                  </div>
                </div>
                {s.type !== "local" && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive shrink-0 rounded-sm p-1 transition-colors"
                    title="Remove server"
                    onClick={() => setRemoveTarget(s)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
      </div>

      {!isLoading && !isError && sshServers.length === 0 && (
        <p className="text-muted-foreground mt-2.5 text-xs">
          Add a server to run sessions on another machine over SSH.
        </p>
      )}

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onDialogClose={onDialogClose}
      />

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o && !deleteServer.isPending) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove server</AlertDialogTitle>
            <AlertDialogDescription>
              Remove &quot;{removeTarget?.name}&quot;? This only removes it from
              your list. Any sessions running on it keep running — you just
              won&apos;t see them here until you add the server back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setRemoveTarget(null)}
              disabled={deleteServer.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteServer.isPending}
              onClick={(e) => {
                // Radix closes on Action click by default; keep the dialog
                // open so the pending spinner is visible until DELETE settles.
                e.preventDefault();
                if (!removeTarget || deleteServer.isPending) return;
                deleteServer.mutate(removeTarget.id, {
                  onSettled: () => setRemoveTarget(null),
                });
              }}
            >
              {deleteServer.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {deleteServer.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

/** Notifications settings section — enable/disable "job finished" push. Its own
 *  component so the push probe (fetch + service-worker checks) only runs when
 *  this tab is open. */
const DURATION_OPTIONS: { label: string; value: number }[] = [
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "5m", value: 300000 },
];

function NotificationsSection() {
  const push = usePushNotifications();
  const busy = push.busy || !push.ready;
  // Global preferences load only once subscribed (nothing to tune otherwise).
  const prefs = usePushSettings(push.subscribed);

  return (
    <Section>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {push.subscribed ? (
            <Bell className="text-chart-1 size-4 shrink-0" />
          ) : (
            <BellOff className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="text-foreground text-sm">Job-finished alerts</span>
        </div>
        <Button
          variant={push.subscribed ? "outline" : "default"}
          size="sm"
          disabled={busy || (!push.available && !push.subscribed)}
          onClick={() => {
            if (push.subscribed) void push.disable();
            else void push.enable();
          }}
          className="shrink-0"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {push.subscribed ? "On" : "Off"}
        </Button>
      </div>

      <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
        Get a push notification when a command finishes in any session — even
        with the tab closed. Alerts name the session only, never its output.
      </p>

      {!push.available && push.disabledReason && (
        <p className="text-muted-foreground mt-2 text-xs">
          {push.disabledReason}
        </p>
      )}
      {push.error && (
        <p className="text-destructive mt-2 text-xs">{push.error}</p>
      )}

      {/* Global preferences — only when enabled (server-side; all devices). */}
      {push.subscribed && (
        <div className="border-border mt-3.5 space-y-3 border-t pt-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground text-sm">Notify after</span>
            <div className="border-border flex overflow-hidden rounded-md border">
              {DURATION_OPTIONS.map((opt) => {
                const active = opt.value === prefs.settings.minDurationMs;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={prefs.saving}
                    onClick={() =>
                      void prefs.update({ minDurationMs: opt.value })
                    }
                    aria-pressed={active}
                    className={cn(
                      "border-border min-w-10 border-l px-2.5 py-1 text-xs transition-colors first:border-l-0",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Only notify for jobs that ran at least this long (shorter ones are
            usually not worth an alert).
          </p>

          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground text-sm">
              Alert if still running
            </span>
            <Button
              variant={prefs.settings.notifyOnStart ? "outline" : "default"}
              size="sm"
              disabled={prefs.saving}
              onClick={() =>
                void prefs.update({
                  notifyOnStart: !prefs.settings.notifyOnStart,
                })
              }
              className="shrink-0"
            >
              {prefs.settings.notifyOnStart ? "On" : "Off"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Also send a one-time alert when a job is still running after the
            threshold above.
          </p>
        </div>
      )}
    </Section>
  );
}

/** A read-only "label: value" row used by the informational sections. */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground min-w-0 truncate text-right">
        {value}
      </span>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  username,
  onLogout,
  logoutPending = false,
  statusState,
  statusText,
  sessionCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Signed-in username; absent in open mode (dev, auth disabled). */
  username?: string;
  onLogout?: () => void;
  /** True while the sign-out request is in flight. */
  logoutPending?: boolean;
  statusState: ConnectionStatus;
  statusText: string;
  sessionCount: number;
}) {
  const fontSize = useTerminalStore((s) => s.terminalFontSize);
  const setFontSize = useTerminalStore((s) => s.setTerminalFontSize);
  const section = useTerminalStore((s) => s.settingsSection);
  const setSection = useTerminalStore((s) => s.setSettingsSection);

  const dotClass = cn(
    "size-[7px] rounded-full",
    statusState === "connected" && "bg-chart-1",
    statusState === "reconnecting" && "bg-chart-2",
    statusState === "disconnected" && "bg-destructive",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="text-sm font-medium">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Preferences for the terminal, agent chat, your account, and the
            gateway connection.
          </DialogDescription>
        </DialogHeader>

        {/* Tab nav — the active tab is stored in `settingsSection` so it can be
            deep-linked with `?settings=<section>`. */}
        <div className="border-border flex border-b" role="tablist">
          {TABS.map((t) => {
            const active = t.key === section;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSection(t.key)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-colors",
                  active
                    ? "text-foreground border-foreground -mb-px border-b-2"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
                )}
              >
                <Icon className="size-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="[&::-webkit-scrollbar-thumb]:bg-border max-h-[min(70dvh,560px)] overflow-y-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar]:w-1.5">
          {/* Appearance — the only section with behavior. */}
          {section === "appearance" && (
            <Section>
              <div className="flex items-center justify-between gap-3">
                <span className="text-foreground text-sm">
                  Terminal font size
                </span>
                <div className="border-border flex overflow-hidden rounded-md border">
                  {FONT_SIZE_OPTIONS.map((opt) => {
                    const active = opt.value === fontSize;
                    return (
                      <button
                        key={String(opt.value)}
                        type="button"
                        onClick={() => setFontSize(opt.value)}
                        aria-pressed={active}
                        className={cn(
                          "border-border min-w-9 border-l px-2.5 py-1 text-xs transition-colors first:border-l-0",
                          active
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/50",
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="text-muted-foreground mt-2.5 text-xs">
                The terminal theme is dark by design (per DESIGN.md); there is
                no theme toggle.
              </p>
            </Section>
          )}

          {/* Notifications — enable/disable "job finished" push. */}
          {section === "notifications" && <NotificationsSection />}

          {/* Agent chat — informational only. */}
          {section === "agent" && (
            <Section>
              <InfoRow
                label="Model"
                value={<span className="font-mono text-xs">{AGENT_MODEL}</span>}
              />
              <div className="text-muted-foreground mt-2 flex gap-2 text-xs leading-relaxed">
                <ShieldCheck className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                <p>
                  Reads (list sessions, read screen, wait) run automatically.
                  Every write — type text, press keys, run command, create
                  session — requires per-write approval. Auto-approve is scoped
                  to the current chat only and is never persisted.
                </p>
              </div>
            </Section>
          )}

          {/* Account — display + existing actions only. */}
          {section === "account" && (
            <Section>
              {onLogout ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <CircleUser className="text-muted-foreground size-4 shrink-0" />
                      <span className="text-foreground truncate text-sm font-medium">
                        {username ?? "Signed in"}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onLogout}
                      disabled={logoutPending}
                      className="shrink-0"
                    >
                      {logoutPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <LogOut className="size-3.5" />
                      )}
                      {logoutPending ? "Signing out…" : "Sign out"}
                    </Button>
                  </div>
                  <p className="text-muted-foreground mt-2.5 text-xs">
                    Password is set via the server environment
                    (GATEWAY_AUTH_PASSWORD_HASH).
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Auth disabled — the gateway is running in open mode (no
                  credentials configured).
                </p>
              )}
            </Section>
          )}

          {/* Connection — read-only display. */}
          {section === "connection" && (
            <Section>
              <InfoRow
                label="Gateway URL"
                value={<span className="font-mono text-xs">{GATEWAY_URL}</span>}
              />
              <InfoRow
                label="Status"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <span className={dotClass} />
                    <span className="text-xs uppercase tracking-wider">
                      {statusText}
                    </span>
                  </span>
                }
              />
              <InfoRow label="Active sessions" value={sessionCount} />
            </Section>
          )}

          {/* Servers — the always-visible multi-server surface. */}
          {section === "servers" && <ServersSection />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
