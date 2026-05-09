export const MANGA_ID_FALLBACK_ORDER = [
  "anilist",
  "mal",
  "provider",
  "slug",
] as const;

export type MangaIdKind = (typeof MANGA_ID_FALLBACK_ORDER)[number];

export interface ResolvedMangaId {
  raw: string;
  kind: MangaIdKind;
  anilistId?: number;
  malId?: number;
  provider?: string;
  providerId?: string;
  slug?: string;
  usedDefaultAniListRule: boolean;
}

const INTEGER_PATTERN = /^\d+$/;
const PREFIXED_ID_PATTERN = /^([a-z0-9_-]+):(.*)$/i;

const parsePositiveInteger = (value: string): number | null => {
  if (!INTEGER_PATTERN.test(value)) return null;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
};

export const resolveMangaId = (input: string): ResolvedMangaId | null => {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const bareNumeric = parsePositiveInteger(raw);
  if (bareNumeric !== null) {
    return {
      raw,
      kind: "anilist",
      anilistId: bareNumeric,
      usedDefaultAniListRule: true,
    };
  }

  const prefixed = raw.match(PREFIXED_ID_PATTERN);
  if (prefixed) {
    const prefix = prefixed[1].toLowerCase();
    const value = prefixed[2].trim();

    if (!value) return null;

    if (prefix === "anilist") {
      const anilistId = parsePositiveInteger(value);
      if (anilistId === null) return null;

      return {
        raw,
        kind: "anilist",
        anilistId,
        usedDefaultAniListRule: false,
      };
    }

    if (prefix === "mal") {
      const malId = parsePositiveInteger(value);
      if (malId === null) return null;

      return {
        raw,
        kind: "mal",
        malId,
        usedDefaultAniListRule: false,
      };
    }

    if (prefix === "provider") {
      const [provider, providerId] = value.split("|", 2);
      if (!provider || !providerId) return null;

      return {
        raw,
        kind: "provider",
        provider: provider.trim().toLowerCase(),
        providerId: providerId.trim(),
        usedDefaultAniListRule: false,
      };
    }

    if (prefix === "slug") {
      return {
        raw,
        kind: "slug",
        slug: value,
        usedDefaultAniListRule: false,
      };
    }

    return {
      raw,
      kind: "slug",
      slug: raw,
      usedDefaultAniListRule: false,
    };
  }

  return {
    raw,
    kind: "slug",
    slug: raw,
    usedDefaultAniListRule: false,
  };
};
