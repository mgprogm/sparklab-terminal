import { useQuery } from "@tanstack/react-query";

import { me } from "../api";

export const authKeys = {
  all: ["auth"] as const,
  me: () => [...authKeys.all, "me"] as const,
};

export function useAuthStatus() {
  return useQuery({
    queryKey: authKeys.me(),
    queryFn: () => me(),
    staleTime: Infinity,
    retry: false,
  });
}
