import { create } from "zustand";
import type {
  AgentBrowserClosed,
  AgentBrowserView,
} from "@sparklab/shared-types";

type BrowserFrame = AgentBrowserView | AgentBrowserClosed;

interface BrowserViewState {
  view: AgentBrowserView | null;
  visible: boolean;
  /** Highest accepted view/close revision per browser, including tombstones. */
  revisions: Record<string, number>;
  ingest: (frame: BrowserFrame) => void;
  hide: () => void;
  show: () => void;
  clear: () => void;
}

/**
 * Ephemeral browser presentation state. It intentionally lives outside the
 * persisted agent-chat store so screenshots cannot enter local/chat history.
 */
export const useBrowserViewStore = create<BrowserViewState>()((set) => ({
  view: null,
  visible: false,
  revisions: {},

  ingest: (frame) =>
    set((state) => {
      if (frame.type === "browser_closed") {
        const knownRevision = state.revisions[frame.browserId] ?? -1;
        if (frame.revision < knownRevision) return state;
        const closesCurrent = state.view?.browserId === frame.browserId;
        return {
          revisions: {
            ...state.revisions,
            [frame.browserId]: frame.revision,
          },
          ...(closesCurrent ? { view: null, visible: false } : {}),
        };
      }

      // Revisions are monotonic within one browser. A different browser id is
      // a new owned browser and therefore replaces any leftover prior view.
      if (frame.revision <= (state.revisions[frame.browserId] ?? -1))
        return state;
      return {
        view: frame,
        revisions: { ...state.revisions, [frame.browserId]: frame.revision },
        // A newly created browser opens automatically. Once the user hides a
        // browser, later screenshots update behind the reopen affordance.
        visible:
          state.view?.browserId === frame.browserId ? state.visible : true,
      };
    }),

  hide: () => set({ visible: false }),
  show: () => set((state) => ({ visible: state.view !== null })),
  clear: () => set({ view: null, visible: false, revisions: {} }),
}));
