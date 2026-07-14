import { useMutation, useQueryClient } from "@tanstack/react-query";

import { login } from "../api";
import { authKeys } from "./use-auth-status";

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ token }: { token: string }) => login(token),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: authKeys.me() });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}
