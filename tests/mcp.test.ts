import { describe, it, expect } from "vitest";
import { parseMcpServers } from "../src/plugins/mcp";

// Guards the MCP_SERVERS config parse/validate: a malformed value must degrade
// to "no servers" (or drop the bad entry) rather than throw, since this feeds
// both plugin enablement and the boot-time connection wiring.

describe("parseMcpServers", () => {
  it("returns null when the value is absent or empty", () => {
    expect(parseMcpServers(undefined)).toBeNull();
    expect(parseMcpServers("")).toBeNull();
    expect(parseMcpServers("   ")).toBeNull();
  });

  it("returns null for non-JSON or non-array JSON", () => {
    expect(parseMcpServers("not json")).toBeNull();
    expect(parseMcpServers("{}")).toBeNull();
    expect(parseMcpServers('{"name":"x","url":"https://x.test"}')).toBeNull();
    expect(parseMcpServers('"a string"')).toBeNull();
    expect(parseMcpServers("42")).toBeNull();
  });

  it("returns an empty array for an empty JSON array", () => {
    expect(parseMcpServers("[]")).toEqual([]);
  });

  it("parses a no-auth server", () => {
    expect(
      parseMcpServers('[{"name":"docs","url":"https://mcp.example.com/sse"}]'),
    ).toEqual([{ name: "docs", url: "https://mcp.example.com/sse" }]);
  });

  it("parses an API-key server", () => {
    expect(
      parseMcpServers(
        '[{"name":"gh","url":"https://mcp.gh.test","apiKey":"sk-123"}]',
      ),
    ).toEqual([{ name: "gh", url: "https://mcp.gh.test", apiKey: "sk-123" }]);
  });

  it("parses multiple servers, preserving order", () => {
    const out = parseMcpServers(
      '[{"name":"a","url":"https://a.test"},{"name":"b","url":"http://b.test","apiKey":"k"}]',
    );
    expect(out).toEqual([
      { name: "a", url: "https://a.test" },
      { name: "b", url: "http://b.test", apiKey: "k" },
    ]);
  });

  it("trims whitespace in name, url, and apiKey", () => {
    expect(
      parseMcpServers(
        '[{"name":"  a  ","url":"  https://a.test  ","apiKey":"  k  "}]',
      ),
    ).toEqual([{ name: "a", url: "https://a.test", apiKey: "k" }]);
  });

  it("treats a blank apiKey as no auth", () => {
    expect(
      parseMcpServers('[{"name":"a","url":"https://a.test","apiKey":"   "}]'),
    ).toEqual([{ name: "a", url: "https://a.test" }]);
  });

  it("drops entries missing name or url", () => {
    expect(
      parseMcpServers(
        '[{"url":"https://a.test"},{"name":"b"},{"name":"","url":"https://c.test"}]',
      ),
    ).toEqual([]);
  });

  it("drops entries whose url is not http(s)", () => {
    expect(
      parseMcpServers(
        '[{"name":"a","url":"ftp://a.test"},{"name":"b","url":"not a url"},{"name":"c","url":"ws://c.test"}]',
      ),
    ).toEqual([]);
  });

  it("drops non-object entries but keeps valid ones", () => {
    expect(
      parseMcpServers(
        '["string", 42, null, {"name":"ok","url":"https://ok.test"}]',
      ),
    ).toEqual([{ name: "ok", url: "https://ok.test" }]);
  });

  it("ignores extra unknown fields", () => {
    expect(
      parseMcpServers(
        '[{"name":"a","url":"https://a.test","extra":true,"oauth":{}}]',
      ),
    ).toEqual([{ name: "a", url: "https://a.test" }]);
  });
});
