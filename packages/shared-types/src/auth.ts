import { z } from "zod";

export const LoginBodySchema = z.object({ token: z.string().min(1) });
export const AuthErrorSchema = z.object({ error: z.string() });
export const MeResponseSchema = z.object({ authenticated: z.boolean() });

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type AuthError = z.infer<typeof AuthErrorSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const WS_CLOSE_UNAUTHORIZED = 4001;
