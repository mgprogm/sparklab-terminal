import { useMutation, useQueryClient } from "@tanstack/react-query";

import { logout } from "../api";
import { authKeys } from "./use-auth-status";

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: authKeys.me() }),
  });
}
