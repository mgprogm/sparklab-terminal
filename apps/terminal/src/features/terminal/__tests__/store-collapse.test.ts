/**
 * @vitest-environment node
 *
 * Tests for the collapse/expand group state in the terminal store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useTerminalStore } from "../store";

describe("collapsedGroups", () => {
  beforeEach(() => {
    useTerminalStore.setState({ collapsedGroups: {} });
  });

  afterEach(() => {
    useTerminalStore.setState({ collapsedGroups: {} });
  });

  it("defaults to an empty object (all expanded)", () => {
    expect(useTerminalStore.getState().collapsedGroups).toEqual({});
  });

  it("toggleGroupCollapsed adds a key when not present (collapse)", () => {
    useTerminalStore.getState().toggleGroupCollapsed("Acme");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      Acme: true,
    });
  });

  it("toggleGroupCollapsed removes a key when present (expand)", () => {
    useTerminalStore.setState({ collapsedGroups: { Acme: true } });
    useTerminalStore.getState().toggleGroupCollapsed("Acme");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({});
  });

  it("handles org/project composite keys", () => {
    useTerminalStore.getState().toggleGroupCollapsed("Acme/checkout");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      "Acme/checkout": true,
    });
    useTerminalStore.getState().toggleGroupCollapsed("Acme/checkout");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({});
  });

  it("preserves other keys when toggling", () => {
    useTerminalStore.setState({
      collapsedGroups: { Acme: true, Beta: true },
    });
    useTerminalStore.getState().toggleGroupCollapsed("Acme");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      Beta: true,
    });
  });
});

describe("expandAncestors", () => {
  beforeEach(() => {
    useTerminalStore.setState({ collapsedGroups: {} });
  });

  afterEach(() => {
    useTerminalStore.setState({ collapsedGroups: {} });
  });

  it("expands the __ungrouped__ key for null org (ungrouped session)", () => {
    useTerminalStore.setState({
      collapsedGroups: { __ungrouped__: true, SomeOrg: true },
    });
    useTerminalStore.getState().expandAncestors(null, null);
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      SomeOrg: true,
    });
  });

  it("does nothing when __ungrouped__ is already expanded", () => {
    useTerminalStore.setState({
      collapsedGroups: { SomeOrg: true },
    });
    useTerminalStore.getState().expandAncestors(null, null);
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      SomeOrg: true,
    });
  });

  it("expands the org key when collapsed", () => {
    useTerminalStore.setState({ collapsedGroups: { Acme: true } });
    useTerminalStore.getState().expandAncestors("Acme", null);
    expect(useTerminalStore.getState().collapsedGroups).toEqual({});
  });

  it("expands both org and project keys when collapsed", () => {
    useTerminalStore.setState({
      collapsedGroups: { Acme: true, "Acme/checkout": true },
    });
    useTerminalStore.getState().expandAncestors("Acme", "checkout");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({});
  });

  it("only expands the target keys, not others", () => {
    useTerminalStore.setState({
      collapsedGroups: {
        Acme: true,
        "Acme/checkout": true,
        Beta: true,
        "Beta/api": true,
      },
    });
    useTerminalStore.getState().expandAncestors("Acme", "checkout");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      Beta: true,
      "Beta/api": true,
    });
  });

  it("is a no-op when ancestors are already expanded", () => {
    const initial = { Beta: true };
    useTerminalStore.setState({ collapsedGroups: initial });
    useTerminalStore.getState().expandAncestors("Acme", "checkout");
    // Beta should still be there, no change.
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      Beta: true,
    });
  });

  // ---- Multi-server namespacing (serverId provided) ----

  it("expands the server, org, and project ancestors with namespaced keys", () => {
    useTerminalStore.setState({
      collapsedGroups: {
        "server:build01": true,
        "build01::Acme": true,
        "build01::Acme/checkout": true,
        // A same-named org on a DIFFERENT server must be left untouched.
        "local::Acme": true,
      },
    });
    useTerminalStore.getState().expandAncestors("Acme", "checkout", "build01");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({
      "local::Acme": true,
    });
  });

  it("expands the server key even for an ungrouped session", () => {
    useTerminalStore.setState({
      collapsedGroups: {
        "server:build01": true,
        "build01::__ungrouped__": true,
      },
    });
    useTerminalStore.getState().expandAncestors(null, null, "build01");
    expect(useTerminalStore.getState().collapsedGroups).toEqual({});
  });
});
