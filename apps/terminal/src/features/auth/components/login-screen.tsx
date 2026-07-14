"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoginBodySchema, type LoginBody } from "@sparklab/shared-types";
import { Button } from "@sparklab/ui/components/ui/button";
import { Input } from "@sparklab/ui/components/ui/input";
import { Label } from "@sparklab/ui/components/ui/label";
import { useForm } from "react-hook-form";

import { RateLimitError, UnauthorizedError } from "../api";
import { useLogin } from "../hooks/use-login";

export function LoginScreen() {
  const loginMutation = useLogin();
  const form = useForm<LoginBody>({ resolver: zodResolver(LoginBodySchema) });
  const error = loginMutation.error;
  const isRateLimited = error instanceof RateLimitError;

  const onSubmit = ({ username, password }: LoginBody) => {
    loginMutation.mutate({ username, password });
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[#2b2622] px-4 text-[#f7f5f0]">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">
        Sparklab Terminal
      </h1>
      <section className="bg-background w-full max-w-sm rounded-lg border border-[#4a443f] p-6 shadow-xl">
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
            Sign in
          </Button>
        </form>
      </section>
    </main>
  );
}
