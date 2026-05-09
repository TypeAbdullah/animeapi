import { describe, expect, test } from "vitest";
import { resolveMangaId } from "../src/providers/manga/id.js";

describe("Manga ID Resolution", () => {
  test("defaults bare numeric IDs to AniList", () => {
    const resolved = resolveMangaId("151807");

    expect(resolved).not.toBeNull();
    expect(resolved?.kind).toBe("anilist");
    expect(resolved?.anilistId).toBe(151807);
    expect(resolved?.usedDefaultAniListRule).toBe(true);
  });

  test("supports explicit MAL IDs", () => {
    const resolved = resolveMangaId("mal:167235");

    expect(resolved).not.toBeNull();
    expect(resolved?.kind).toBe("mal");
    expect(resolved?.malId).toBe(167235);
    expect(resolved?.usedDefaultAniListRule).toBe(false);
  });

  test("supports explicit provider IDs", () => {
    const resolved = resolveMangaId("provider:mangadex|4f721f7f-f6f5-4f6f-bf63-6f2f8975934f");

    expect(resolved).not.toBeNull();
    expect(resolved?.kind).toBe("provider");
    expect(resolved?.provider).toBe("mangadex");
    expect(resolved?.providerId).toBe("4f721f7f-f6f5-4f6f-bf63-6f2f8975934f");
  });

  test("falls back to slug strategy for non-prefixed strings", () => {
    const resolved = resolveMangaId("solo-leveling");

    expect(resolved).not.toBeNull();
    expect(resolved?.kind).toBe("slug");
    expect(resolved?.slug).toBe("solo-leveling");
  });

  test("rejects invalid prefixed values", () => {
    expect(resolveMangaId("anilist:not-a-number")).toBeNull();
    expect(resolveMangaId("mal:0")).toBeNull();
    expect(resolveMangaId("provider:mangadex")).toBeNull();
  });
});
