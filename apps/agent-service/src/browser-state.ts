const DEFAULT_MAX_STATE_CHARS = 48_000;
const MAX_TABS = 8;

type BrowserState = Record<string, unknown>;

/**
 * Keep model-facing browser state valid and compact. Browser Use currently
 * returns this bounded shape; selecting its public fields here prevents a
 * future upstream field from silently consuming the model context window.
 */
export function serializeBrowserState(
  state: BrowserState,
  maxChars = DEFAULT_MAX_STATE_CHARS,
): string {
  const elements = Array.isArray(state.interactive_elements)
    ? state.interactive_elements
    : [];
  const summary: BrowserState = {
    url: boundedString(state.url, 2048),
    title: boundedString(state.title, 500),
    tabs: compactTabs(state.tabs),
    ...(Array.isArray(state.tabs) && state.tabs.length > MAX_TABS
      ? { tab_count: state.tabs.length }
      : {}),
    viewport: compactPair(state.viewport, "width", "height"),
    page: compactPair(state.page, "width", "height"),
    scroll: compactPair(state.scroll, "x", "y"),
    screenshot_dimensions: compactPair(
      state.screenshot_dimensions,
      "width",
      "height",
    ),
    interactive_elements: [],
  };

  let low = 0;
  let high = elements.length;
  let result = JSON.stringify(summary);
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      ...summary,
      interactive_elements: elements.slice(0, count).map(compactElement),
      ...(count < elements.length
        ? {
            truncated: {
              interactive_elements: elements.length - count,
            },
          }
        : {}),
    });
    if (candidate.length <= maxChars) {
      result = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return result;
}

function compactTabs(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TABS).map((tab) => {
    if (!tab || typeof tab !== "object") return {};
    const record = tab as BrowserState;
    return {
      url: boundedString(record.url, 2048),
      title: boundedString(record.title, 500),
    };
  });
}

function compactPair(value: unknown, first: string, second: string) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as BrowserState;
  return {
    [first]: boundedNumber(record[first]),
    [second]: boundedNumber(record[second]),
  };
}

function compactElement(value: unknown): BrowserState {
  if (!value || typeof value !== "object") return {};
  const element = value as BrowserState;
  return {
    index: element.index,
    tag: boundedString(element.tag, 100),
    text: boundedString(element.text, 500),
    ...(typeof element.placeholder === "string"
      ? { placeholder: boundedString(element.placeholder, 500) }
      : {}),
    ...(typeof element.href === "string"
      ? { href: boundedString(element.href, 2048) }
      : {}),
  };
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function boundedNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
