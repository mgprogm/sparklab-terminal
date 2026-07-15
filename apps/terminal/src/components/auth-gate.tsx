"use client";

import { Loader2 } from "lucide-react";

import { LoginScreen, useAuthStatus } from "@/features/auth";
import { TerminalShell } from "@/features/terminal";

export function AuthGate() {
  const { data, isLoading } = useAuthStatus();

  if (isLoading)
    return (
      <main className="bg-background flex min-h-dvh items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </main>
    );
  if (!data?.authenticated) return <LoginScreen />;
  return <TerminalShell />;
}
