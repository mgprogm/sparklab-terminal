export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  allowMissingOrigin: boolean,
): boolean {
  if (!origin) return allowMissingOrigin;
  return allowedOrigins.has(origin);
}
