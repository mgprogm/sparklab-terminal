import { create } from "zustand";
import { persist } from "zustand/middleware";

interface DemoState {
  /** Last submitted greeting, persisted to localStorage. */
  lastGreeting: string | null;
  setLastGreeting: (greeting: string) => void;
}

export const useDemoStore = create<DemoState>()(
  persist(
    (set) => ({
      lastGreeting: null,
      setLastGreeting: (greeting) => set({ lastGreeting: greeting }),
    }),
    { name: "demo-store" },
  ),
);
