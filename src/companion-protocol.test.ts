import { describe, expect, it } from "vitest";
import { isLocalRetryContext, isTaskContext } from "./companion-protocol";

const bindingScope = "a".repeat(64);

describe("companion protocol context validation", () => {
  it("rejects oversized and unsafe task identity fields", () => {
    const base = {
      bindingScope,
      taskId: 1,
      sourceUrl: "https://example.com/article",
      contentVersion: "1:1",
      notePath: "Clippings/article.md",
      daily: false,
    };
    expect(isTaskContext(base)).toBe(true);
    expect(isTaskContext({ ...base, sourceUrl: `https://example.com/${"x".repeat(8200)}` })).toBe(false);
    expect(isTaskContext({ ...base, contentVersion: "x".repeat(257) })).toBe(false);
    expect(isTaskContext({ ...base, notePath: "../outside.md" })).toBe(false);
    expect(isTaskContext({ ...base, notePath: "Clippings/line\nbreak.md" })).toBe(false);
  });

  it("validates local retry folders and revisions", () => {
    const base = {
      bindingScope,
      taskId: 1,
      sourceUrl: "https://example.com/article",
      revision: "1:1",
      targetFolder: "Clippings",
    };
    expect(isLocalRetryContext(base)).toBe(true);
    expect(isLocalRetryContext({ ...base, targetFolder: "Clippings/../outside" })).toBe(false);
    expect(isLocalRetryContext({ ...base, revision: "x".repeat(129) })).toBe(false);
    expect(isLocalRetryContext({ ...base, sourceUrl: "https://user:pass@example.com/article" })).toBe(false);
  });
});
