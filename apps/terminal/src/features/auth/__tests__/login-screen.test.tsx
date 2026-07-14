import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/use-login", () => ({ useLogin: vi.fn() }));

import { UnauthorizedError } from "../api";
import { LoginScreen } from "../components/login-screen";
import { useLogin } from "../hooks/use-login";

function wrap() {
  const queryClient = new QueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("LoginScreen", () => {
  beforeEach(() => {
    vi.mocked(useLogin).mockReset();
    vi.mocked(useLogin).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof useLogin>);
  });

  it("renders token field and submit button", () => {
    render(<LoginScreen />, { wrapper: wrap() });
    expect(screen.getByLabelText(/access token/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
  });

  it("submits form with entered token", async () => {
    const user = userEvent.setup();

    render(<LoginScreen />, { wrapper: wrap() });

    await user.type(screen.getByLabelText(/access token/i), "secret-token");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    const mutate = vi.mocked(useLogin).mock.results[0]!.value.mutate;
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({ token: "secret-token" }),
    );
  });

  it("shows invalid token error on 401", () => {
    vi.mocked(useLogin).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: new UnauthorizedError(),
    } as unknown as ReturnType<typeof useLogin>);

    render(<LoginScreen />, { wrapper: wrap() });

    expect(screen.getByText(/invalid token/i)).toBeTruthy();
  });
});
