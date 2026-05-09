import { describe, expect, test } from "vitest";
import { buildChapterKey, parseChapterKey } from "../src/providers/manga/service.js";

describe("Manga Chapter Key", () => {
  test("builds and parses stable chapter keys", () => {
    const key = buildChapterKey("mangadex", "chapter-abc-123", 12.5);
    const parsed = parseChapterKey(key);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("mangadex");
    expect(parsed?.chapterId).toBe("chapter-abc-123");
    expect(parsed?.chapterNumber).toBe(12.5);
  });

  test("supports missing chapter number", () => {
    const key = buildChapterKey("asurascans", "xyz", null);
    const parsed = parseChapterKey(key);

    expect(parsed).not.toBeNull();
    expect(parsed?.provider).toBe("asurascans");
    expect(parsed?.chapterId).toBe("xyz");
    expect(parsed?.chapterNumber).toBeNull();
  });

  test("rejects malformed chapter keys", () => {
    expect(parseChapterKey("bad-key")).toBeNull();
    expect(parseChapterKey(":na:abc")).toBeNull();
  });
});
