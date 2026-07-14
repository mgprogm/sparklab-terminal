/**
 * Query-key factory pattern.
 *
 * Each feature defines its keys as a hierarchy of arrays. Using a factory
 * ensures consistency and makes invalidation easy:
 *
 *   queryClient.invalidateQueries({ queryKey: demoKeys.all });
 *   queryClient.invalidateQueries({ queryKey: demoKeys.lists() });
 */
export const demoKeys = {
  all: ["demo"] as const,
  lists: () => [...demoKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...demoKeys.lists(), filters] as const,
  details: () => [...demoKeys.all, "detail"] as const,
  detail: (id: string) => [...demoKeys.details(), id] as const,
};
