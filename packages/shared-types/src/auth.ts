import { z } from "zod";

export const LoginBodySchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});
export const AuthErrorSchema = z.object({ error: z.string() });
// `username` is present in auth mode; absent means the gateway runs in open
// mode (dev, no credentials configured) — the UI uses that to hide Sign out.
export const MeResponseSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().optional(),
});

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type AuthError = z.infer<typeof AuthErrorSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const WS_CLOSE_UNAUTHORIZED = 4001;
