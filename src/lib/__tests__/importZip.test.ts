import { describe, it, expect, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

vi.mock("../vaultStorage", () => import("./fakeVault"));
const { readMarkdownZip } = await import("../importZip");

describe("readMarkdownZip", () => {
  it("keeps folders, skips non-Markdown and junk, unwraps a single root folder", () => {
    const zip = zipSync({
      "Vault/": new Uint8Array(),
      "Vault/Ideas/On walking.md": strToU8("﻿line one\r\nline two"),
      "Vault/Inbox.MD": strToU8("# Inbox"),
      "Vault/Empty/": new Uint8Array(),
      "Vault/image.png": new Uint8Array([1, 2, 3]),
      "Vault/.obsidian/app.md": strToU8("hidden"),
      "__MACOSX/Vault/._Inbox.md": strToU8("junk"),
    });
    const result = readMarkdownZip(zip);
    expect(result.notes).toEqual([
      { path: "Ideas/On walking.md", body: "line one\nline two" },
      { path: "Inbox.md", body: "# Inbox" },
    ]);
    expect(result.emptyFolders).toEqual(["Empty"]);
    expect(result.skipped).toBe(3);
  });

  it("keeps several top-level folders as they are and refuses path escapes", () => {
    const zip = zipSync({
      "A/one.md": strToU8("1"),
      "B/two.md": strToU8("2"),
      "../evil.md": strToU8("x"),
    });
    expect(readMarkdownZip(zip).notes.map((n) => n.path)).toEqual(["A/one.md", "B/two.md"]);
  });
});
