import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LoginBody } from "@sparklab/shared-types";

import { login } from "../api";
import { authKeys } from "./use-auth-status";

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: LoginBody) =>
      login(username, password),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: authKeys.me() });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
