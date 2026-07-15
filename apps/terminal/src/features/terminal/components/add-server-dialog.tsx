"use client";

/**
 * AddServerDialog — register an ssh server ("Connected Servers", MVP).
 *
 * Auth is key-based by default; a per-server toggle switches to password auth
 * (the password is stored server-side in the gitignored servers.json and is
 * never returned over the wire — a deliberate departure from the original
 * key-only trust model, chosen for hosts that only allow password login). The
 * registry `id` is derived from the display name (slugified) since the UX form
 * does not expose it; the gateway enforces uniqueness and rejects collisions
 * with a surfaced error.
 *
 * Opened from two entry points (the Servers settings tab and the sidebar's
 * "Add server" row); both mount this same controlled component.
 *
 * Styling: DESIGN.md theme tokens only, lucide-react icons, @sparklab/ui
 * primitives — mirrors the New-session dialog chrome.
 */

import { Button } from "@sparklab/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { Input } from "@sparklab/ui/components/ui/input";
import { Label } from "@sparklab/ui/components/ui/label";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { useState } from "react";

import { useCreateServer, useTestServer } from "../hooks/use-servers";

import type { CreateServerRequest } from "@sparklab/shared-types";

/** Slugify a display name into a valid ServerId
 *  (`^[A-Za-z0-9][A-Za-z0-9_-]*$`, max 64). Falls back to "server". */
function slugifyId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "server";
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "failed"; message: string };

export function AddServerDialog({
  open,
  onOpenChange,
  onDialogClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the dialog closes so a caller can reclaim focus. */
  onDialogClose?: () => void;
}) {
  const createServer = useCreateServer();
  const testServer = useTestServer();

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [authMethod, setAuthMethod] = useState<"key" | "password">("key");
  const [identityFile, setIdentityFile] = useState("");
  const [password, setPassword] = useState("");

  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

  const portNum = port.trim() === "" ? 22 : Number(port);
  const portValid =
    Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const canAdd =
    name.trim() !== "" &&
    host.trim() !== "" &&
    user.trim() !== "" &&
    portValid &&
    (authMethod === "key" || password !== "");

  const reset = () => {
    setName("");
    setHost("");
    setUser("");
    setPort("22");
    setAuthMethod("key");
    setIdentityFile("");
    setPassword("");
    setTest({ kind: "idle" });
    setFormError(null);
  };

  const close = () => {
    onOpenChange(false);
    reset();
    onDialogClose?.();
  };

  // Any field edit invalidates a stale test result (must not mislead).
  const onField =
    (setter: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setTest({ kind: "idle" });
      setFormError(null);
    };

  // Reset a stale test result when the auth method or password changes too.
  const onAuthChange = (method: "key" | "password") => {
    setAuthMethod(method);
    setTest({ kind: "idle" });
    setFormError(null);
  };

  const buildRequest = (): CreateServerRequest => ({
    id: slugifyId(name),
    name: name.trim(),
    host: host.trim(),
    user: user.trim() || undefined,
    port: portValid ? portNum : undefined,
    identityFile:
      authMethod === "key" ? identityFile.trim() || undefined : undefined,
    password: authMethod === "password" ? password || undefined : undefined,
  });

  const handleTest = () => {
    if (host.trim() === "") return;
    setTest({ kind: "testing" });
    testServer.mutate(buildRequest(), {
      onSuccess: (res) => {
        if (res.reachability === "ok") {
          setTest({ kind: "ok" });
        } else {
          setTest({
            kind: "failed",
            message:
              res.error ??
              `Couldn't reach ${host.trim()}:${String(portNum)}. Check the host and port.`,
          });
        }
      },
      onError: (err: unknown) => {
        setTest({
          kind: "failed",
          message: `Connection failed: ${err instanceof Error ? err.message : String(err)}.`,
        });
      },
    });
  };

  const handleAdd = () => {
    if (!canAdd) return;
    setFormError(null);
    createServer.mutate(buildRequest(), {
      onSuccess: () => {
        close();
      },
      onError: (err: unknown) => {
        setFormError(
          `Couldn't add the server. ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  };

  const adding = createServer.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label
                htmlFor="server-name"
                className="text-muted-foreground text-xs"
              >
                Name
              </Label>
              <Input
                id="server-name"
                placeholder="Build server"
                value={name}
                onChange={onField(setName)}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={48}
              />
              {formError === null && name.trim() === "" && (
                <span className="sr-only">Give the server a name.</span>
              )}
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="server-host"
                className="text-muted-foreground text-xs"
              >
                Host
              </Label>
              <Input
                id="server-host"
                placeholder="10.0.0.12 or build.internal"
                value={host}
                onChange={onField(setHost)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="server-user"
                className="text-muted-foreground text-xs"
              >
                User
              </Label>
              <Input
                id="server-user"
                placeholder="deploy"
                value={user}
                onChange={onField(setUser)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="server-port"
                className="text-muted-foreground text-xs"
              >
                Port
              </Label>
              <Input
                id="server-port"
                placeholder="22"
                value={port}
                onChange={onField(setPort)}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                className="max-w-24"
              />
              {!portValid && port.trim() !== "" && (
                <p className="text-destructive text-xs">
                  Port must be between 1 and 65535.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Authentication
              </Label>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant={authMethod === "key" ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={authMethod === "key"}
                  onClick={() => onAuthChange("key")}
                >
                  SSH key
                </Button>
                <Button
                  type="button"
                  variant={authMethod === "password" ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={authMethod === "password"}
                  onClick={() => onAuthChange("password")}
                >
                  Password
                </Button>
              </div>
            </div>

            {authMethod === "key" ? (
              <div className="space-y-1.5">
                <Label
                  htmlFor="server-identity"
                  className="text-muted-foreground text-xs"
                >
                  Identity file (optional)
                </Label>
                <Input
                  id="server-identity"
                  placeholder="~/.ssh/id_ed25519"
                  value={identityFile}
                  onChange={onField(setIdentityFile)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label
                  htmlFor="server-password"
                  className="text-muted-foreground text-xs"
                >
                  Password
                </Label>
                <Input
                  id="server-password"
                  type="password"
                  placeholder="SSH login password"
                  value={password}
                  onChange={onField(setPassword)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  Stored on the gateway host (in the gitignored servers.json) so
                  it can reconnect. SSH keys are more secure when the host
                  supports them.
                </p>
              </div>
            )}

            {/* Test connection — optional; never blocks Add. */}
            <div className="flex items-center gap-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={test.kind === "testing" || host.trim() === ""}
              >
                {test.kind === "testing" && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                {test.kind === "testing" ? "Testing…" : "Test connection"}
              </Button>
              {test.kind === "testing" && (
                <span className="text-muted-foreground text-xs">
                  Testing connection…
                </span>
              )}
              {test.kind === "ok" && (
                <span className="text-chart-1 flex items-center gap-1.5 text-xs">
                  <CircleCheck className="size-3.5" />
                  Connected. The gateway reached {host.trim()} over SSH.
                </span>
              )}
              {test.kind === "failed" && (
                <span className="text-destructive flex items-center gap-1.5 text-xs">
                  <CircleAlert className="size-3.5 shrink-0" />
                  {test.message}
                </span>
              )}
            </div>

            {formError && (
              <p className="text-destructive text-xs">{formError}</p>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canAdd || adding}>
              {adding && <Loader2 className="size-3.5 animate-spin" />}
              {adding ? "Adding…" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
