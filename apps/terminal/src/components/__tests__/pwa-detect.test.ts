import { describe, expect, it } from "vitest";

import { isIosSafari, isStandalonePwa, isUpdateWaiting } from "../pwa-detect";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

describe("isIosSafari", () => {
  it("true for iPhone Safari", () => {
    expect(isIosSafari(IPHONE_SAFARI, "iPhone", 5)).toBe(true);
  });
  it("false for iPhone Chrome (CriOS) — cannot add to home screen", () => {
    expect(isIosSafari(IPHONE_CHROME, "iPhone", 5)).toBe(false);
  });
  it("true for iPadOS Safari reporting as MacIntel with touch", () => {
    expect(isIosSafari(IPAD_SAFARI_AS_MAC, "MacIntel", 5)).toBe(true);
  });
  it("false for a real Mac (MacIntel, no touch)", () => {
    expect(isIosSafari(IPAD_SAFARI_AS_MAC, "MacIntel", 0)).toBe(false);
  });
  it("false for desktop Chrome", () => {
    expect(isIosSafari(DESKTOP_CHROME, "Win32", 0)).toBe(false);
  });
});

describe("isStandalonePwa", () => {
  it("true when navigator.standalone (iOS installed)", () => {
    expect(isStandalonePwa(true, false)).toBe(true);
  });
  it("true when display-mode: standalone matches", () => {
    expect(isStandalonePwa(undefined, true)).toBe(true);
  });
  it("false in a normal browser tab", () => {
    expect(isStandalonePwa(false, false)).toBe(false);
    expect(isStandalonePwa(undefined, false)).toBe(false);
  });
});

describe("isUpdateWaiting", () => {
  it("true when installed AND a controller already exists (update)", () => {
    expect(isUpdateWaiting("installed", true)).toBe(true);
  });
  it("false on first install (no controller) — no prompt", () => {
    expect(isUpdateWaiting("installed", false)).toBe(false);
  });
  it("false for non-installed states", () => {
    expect(isUpdateWaiting("installing", true)).toBe(false);
    expect(isUpdateWaiting("activated", true)).toBe(false);
  });
});
