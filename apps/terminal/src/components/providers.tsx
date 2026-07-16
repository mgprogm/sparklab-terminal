"use client";

import { TooltipProvider } from "@sparklab/ui/components/ui/tooltip";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useState } from "react";

import { InstallPrompt } from "@/components/install-prompt";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { UnauthorizedError } from "@/features/auth/api";
import { authKeys } from "@/features/auth/hooks/use-auth-status";

let queryClient: QueryClient;

const getQueryClient = () => {
  queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof UnauthorizedError) {
          void queryClient.invalidateQueries({ queryKey: authKeys.me() });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof UnauthorizedError) {
          void queryClient.invalidateQueries({ queryKey: authKeys.me() });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  });
  return queryClient;
};

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        {/* PWA: register the service worker (prod-only) and offer an
            unobtrusive install affordance. Both render nothing until active. */}
        <ServiceWorkerRegister />
        <InstallPrompt />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
