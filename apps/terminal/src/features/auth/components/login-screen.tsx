"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoginBodySchema, type LoginBody } from "@sparklab/shared-types";
import { Button } from "@sparklab/ui/components/ui/button";
import { Input } from "@sparklab/ui/components/ui/input";
import { Label } from "@sparklab/ui/components/ui/label";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { RateLimitError, UnauthorizedError } from "../api";
import { LoginBackground } from "./login-background";
import { useLogin } from "../hooks/use-login";

export function LoginScreen() {
  const loginMutation = useLogin();
  const form = useForm<LoginBody>({ resolver: zodResolver(LoginBodySchema) });
  const error = loginMutation.error;
  const isRateLimited = error instanceof RateLimitError;
  // Stealth mode: the page shows only the animated background until the
  // user presses Ctrl+Space, which toggles the login form.
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === "Space") {
        event.preventDefault();
        setRevealed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (revealed) form.setFocus("username");
  }, [revealed, form]);

  const onSubmit = ({ username, password }: LoginBody) => {
    loginMutation.mutate({ username, password });
  };

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#2b2622] px-4 text-[#f7f5f0]">
      <LoginBackground />
      <div
        aria-hidden={!revealed}
        className={`relative flex w-full flex-col items-center transition-all duration-500 ${
          revealed
            ? "translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-2 opacity-0"
        }`}
      >
        <h1 className="relative mb-6 text-3xl font-semibold tracking-tight">
          Sparklab Terminal
        </h1>
        <section className="bg-background relative w-full max-w-sm rounded-lg border border-[#4a443f] p-6 shadow-xl">
          <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)}>
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="text-base"
                aria-invalid={Boolean(form.formState.errors.username)}
                {...form.register("username")}
              />
              {form.formState.errors.username && (
                <p className="text-destructive text-sm">
                  {form.formState.errors.username.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                className="text-base"
                aria-invalid={Boolean(form.formState.errors.password)}
                {...form.register("password")}
              />
              {form.formState.errors.password && (
                <p className="text-destructive text-sm">
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>
            {error instanceof UnauthorizedError && (
              <p className="text-destructive text-sm">
                Invalid username or password.
              </p>
            )}
            {isRateLimited && (
              <p className="text-destructive text-sm">
                Too many attempts. Retry in {error.retryAfter}s.
              </p>
            )}
            <Button
              type="submit"
              className="min-h-[44px] w-full"
              disabled={loginMutation.isPending || isRateLimited}
            >
              {loginMutation.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {loginMutation.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </section>
      </div>
    </main>
  );
}
