import { describe, expect, test } from "vitest";
import { buildMangaRewriteUpstreamCandidates } from "../src/providers/manga/route.js";

describe("Manga Rewrite Candidate Builder", () => {
  test("builds standard provider candidates with base + common manga prefixes", () => {
    const candidates = buildMangaRewriteUpstreamCandidates(
      "https://api.tatakai.me:4010/api/v2/manga/mangaball/search?q=solo&page=1",
      "mangaball",
      false,
      "https://upstream.example"
    );

    expect(candidates).toContain("https://upstream.example/manga/mangaball/search?q=solo&page=1");
    expect(candidates).toContain("https://upstream.example/api/v2/manga/mangaball/search?q=solo&page=1");
  });

  test("adds home fallback for empty provider tail", () => {
    const candidates = buildMangaRewriteUpstreamCandidates(
      "https://api.tatakai.me:4010/api/v2/manga/allmanga",
      "allmanga",
      false,
      "https://upstream.example"
    );

    expect(candidates).toContain("https://upstream.example/manga/allmanga");
    expect(candidates).toContain("https://upstream.example/manga/allmanga/home");
  });

  test("adds adult alias variants and home fallback", () => {
    const candidates = buildMangaRewriteUpstreamCandidates(
      "https://api.tatakai.me:4010/api/v2/manga/adult/atsu",
      "atsu",
      true,
      "https://upstream.example/manga"
    );

    expect(candidates).toContain("https://upstream.example/manga/atsu/adult");
    expect(candidates).toContain("https://upstream.example/manga/atsu/adult/home");
    expect(candidates).toContain("https://upstream.example/manga/adult/atsu");
  });
});
