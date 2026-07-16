/**
 * Pure PWA-environment predicates, split out from the React components so they
 * can be unit-tested without a real `navigator`. No DOM access here — callers
 * pass the raw values in.
 */

/**
 * True for iOS/iPadOS Safari (the only iOS browser that can "Add to Home
 * Screen", and the only place iOS Web Push works — from an installed PWA).
 * Excludes the in-app WebKit wrappers (Chrome/Firefox/Edge/Opera on iOS) which
 * cannot install to the home screen. iPadOS 13+ reports as "MacIntel" with a
 * touch screen, so that combination counts as iOS too.
 */
export function isIosSafari(
  ua: string,
  platform: string,
  maxTouchPoints: number,
): boolean {
  const iOS =
    /iP(hone|ad|od)/.test(ua) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  if (!iOS) return false;
  const otherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
  return /Safari/.test(ua) && !otherIosBrowser;
}

/**
 * True when the app is already running as an installed PWA (standalone). On iOS
 * that surfaces as the non-standard `navigator.standalone`; elsewhere it's the
 * `display-mode: standalone` media query.
 */
export function isStandalonePwa(
  navigatorStandalone: boolean | undefined,
  standaloneMediaMatches: boolean,
): boolean {
  return navigatorStandalone === true || standaloneMediaMatches === true;
}

/**
 * True when a newly installed service worker is an UPDATE (an existing worker
 * already controls the page) rather than the first-ever install — the signal
 * to show the "Update available — reload" prompt. On a first install there is
 * no controller, so we stay silent.
 */
export function isUpdateWaiting(
  workerState: string,
  hasController: boolean,
): boolean {
  return workerState === "installed" && hasController;
}
