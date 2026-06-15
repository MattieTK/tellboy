import { describe, it, expect } from "vitest";
import { envFlag } from "../src/plugins/types";
import { collectTools, enabledPluginNames } from "../src/plugins";
import { unsafeProposedPaths } from "../src/plugins/selfdev";

// Guards which capabilities the bot exposes. A regression here could silently
// drop tools (bot loses abilities) or expose them when misconfigured.

const FULL_ENV = {
  BRAVE_API_KEY: "k",
  GITHUB_TOKEN: "t",
  GITHUB_REPO: "o/r",
  DEPLOYER: {},
} as unknown as Env;

describe("envFlag", () => {
  it("reads truthy values", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      expect(envFlag({ ENABLE_X: v } as unknown as Env, "x")).toBe(true);
    }
  });
  it("reads falsy values", () => {
    for (const v of ["0", "false", "no", "off"]) {
      expect(envFlag({ ENABLE_X: v } as unknown as Env, "x")).toBe(false);
    }
  });
  it("returns undefined when unset, so callers fall back to auto-detect", () => {
    expect(envFlag({} as unknown as Env, "x")).toBeUndefined();
  });
});

describe("plugin enablement", () => {
  it("enables every plugin when fully configured", () => {
    const names = enabledPluginNames(FULL_ENV).sort();
    expect(names).toEqual(
      [
        "automations",
        "briefings",
        "deploy",
        "logs",
        "persona",
        "reminders",
        "selfdev",
        "websearch",
      ].sort(),
    );
  });

  it("keeps the dependency-free plugins on with no config", () => {
    // automations, briefings, reminders and persona have no external
    // dependency, so all four default on.
    expect(enabledPluginNames({} as unknown as Env).sort()).toEqual(
      ["automations", "briefings", "persona", "reminders"].sort(),
    );
  });

  it("auto-enables websearch only with a Brave key", () => {
    expect(enabledPluginNames({ BRAVE_API_KEY: "k" } as unknown as Env)).toContain(
      "websearch",
    );
    expect(enabledPluginNames({} as unknown as Env)).not.toContain("websearch");
  });

  it("requires both token and repo for selfdev", () => {
    expect(
      enabledPluginNames({ GITHUB_TOKEN: "t" } as unknown as Env),
    ).not.toContain("selfdev");
    expect(
      enabledPluginNames({ GITHUB_TOKEN: "t", GITHUB_REPO: "o/r" } as unknown as Env),
    ).toContain("selfdev");
  });

  it("gates deploy and logs on the DEPLOYER binding", () => {
    expect(enabledPluginNames({} as unknown as Env)).not.toContain("deploy");
    const withBinding = enabledPluginNames({ DEPLOYER: {} } as unknown as Env);
    expect(withBinding).toEqual(expect.arrayContaining(["deploy", "logs"]));
  });

  it("honours an explicit ENABLE_ override", () => {
    expect(
      enabledPluginNames({ ENABLE_REMINDERS: "false" } as unknown as Env),
    ).not.toContain("reminders");
  });
});

describe("unsafeProposedPaths (selfdev self-edit guard)", () => {
  it("blocks the deploy machinery and git internals", () => {
    expect(
      unsafeProposedPaths([
        ".github/workflows/deploy.yml",
        "deployer/src/index.ts",
        ".git/hooks/pre-push",
        ".git/config",
        ".git",
      ]),
    ).toEqual([
      ".github/workflows/deploy.yml",
      "deployer/src/index.ts",
      ".git/hooks/pre-push",
      ".git/config",
      ".git",
    ]);
  });

  it("blocks absolute paths and ones that escape the tree via ..", () => {
    expect(unsafeProposedPaths(["/etc/passwd"])).toEqual(["/etc/passwd"]);
    expect(unsafeProposedPaths(["../secrets.txt"])).toEqual(["../secrets.txt"]);
    expect(unsafeProposedPaths(["src/../../x"])).toEqual(["src/../../x"]);
    expect(unsafeProposedPaths(["src\\..\\..\\x"])).toEqual(["src\\..\\..\\x"]);
  });

  it("allows ordinary in-tree source paths", () => {
    expect(
      unsafeProposedPaths([
        "src/agent.ts",
        "src/plugins/selfdev.ts",
        "tests/rich.test.ts",
        "README.md",
        // a filename that merely contains the substring ".git" is fine
        "src/gitignore-notes.md",
      ]),
    ).toEqual([]);
  });
});

describe("collectTools", () => {
  it("exposes the expected tools when fully configured", () => {
    const tools = collectTools({} as never, FULL_ENV);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "web_search",
        "set_reminder",
        "list_reminders",
        "cancel_reminder",
        "create_automation",
        "list_automations",
        "cancel_automation",
        "set_briefing",
        "disable_briefing",
        "read_source",
        "list_source",
        "propose_change",
        "list_pull_requests",
        "merge_pull_request",
        "close_pull_request",
        "request_deploy",
        "read_logs",
        "set_persona",
      ].sort(),
    );
  });
});
