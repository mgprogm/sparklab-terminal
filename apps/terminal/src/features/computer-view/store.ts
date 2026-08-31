import { create } from "zustand";
import type {
  AgentComputerClosed,
  AgentComputerView,
} from "@sparklab/shared-types";

type ComputerFrame = AgentComputerView | AgentComputerClosed;

interface ComputerViewState {
  view: AgentComputerView | null;
  visible: boolean;
  /** Highest accepted view/close revision per computer, including tombstones. */
  revisions: Record<string, number>;
  ingest: (frame: ComputerFrame) => void;
  hide: () => void;
  show: () => void;
  clear: () => void;
}

/**
 * Ephemeral virtual-computer presentation state. Mirrors `browser-view/store`:
 * it lives outside the persisted agent-chat store so desktop screenshots never
 * enter local/chat history, revisions are monotonic per computer id, and a
 * close records a tombstone so a late `computer_view` cannot reopen the view.
 */
export const useComputerViewStore = create<ComputerViewState>()((set) => ({
  view: null,
  visible: false,
  revisions: {},

  ingest: (frame) =>
    set((state) => {
      if (frame.type === "computer_closed") {
        const knownRevision = state.revisions[frame.computerId] ?? -1;
        if (frame.revision < knownRevision) return state;
        const closesCurrent = state.view?.computerId === frame.computerId;
        return {
          revisions: {
            ...state.revisions,
            [frame.computerId]: frame.revision,
          },
          ...(closesCurrent ? { view: null, visible: false } : {}),
        };
      }

      if (frame.revision <= (state.revisions[frame.computerId] ?? -1))
        return state;
      return {
        view: frame,
        revisions: { ...state.revisions, [frame.computerId]: frame.revision },
        visible:
          state.view?.computerId === frame.computerId ? state.visible : true,
      };
    }),

  hide: () => set({ visible: false }),
  show: () => set((state) => ({ visible: state.view !== null })),
  clear: () => set({ view: null, visible: false, revisions: {} }),
}));
