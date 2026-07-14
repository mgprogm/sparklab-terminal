"use client";

import { LoginScreen, useAuthStatus } from "@/features/auth";
import { TerminalShell } from "@/features/terminal";

export function AuthGate() {
  const { data, isLoading } = useAuthStatus();

  if (isLoading) return null;
  if (!data?.authenticated) return <LoginScreen />;
  return <TerminalShell />;
}
