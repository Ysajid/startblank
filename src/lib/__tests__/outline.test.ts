import { describe, it, expect } from "vitest";
import { outline } from "../outline";

describe("outline", () => {
  it("lists headings with their levels and positions, as they read", () => {
    const body = "# On **walking**\n\nText\n\n## See [[Ideas/Reading|reading]] and `code` ##\n\nTitle\n=====\n";
    expect(outline(body)).toEqual([
      { level: 1, text: "On walking", from: 0 },
      { level: 2, text: "See reading and code", from: body.indexOf("## See") },
      { level: 1, text: "Title", from: body.indexOf("Title") },
    ]);
  });

  it("ignores frontmatter, code blocks and things that aren't headings", () => {
    const body = "---\ntitle: x\n---\n```\n# not a heading\n```\n#hashtag\n- item\n---\n### Real\n";
    expect(outline(body)).toEqual([{ level: 3, text: "Real", from: body.indexOf("### Real") }]);
  });
});
