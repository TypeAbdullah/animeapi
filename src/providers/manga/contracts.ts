export type UnifiedMediaType = "anime" | "manga" | "manhwa" | "manhua";

export type UnifiedContentStatus =
  | "ongoing"
  | "completed"
  | "hiatus"
  | "cancelled"
  | "unreleased"
  | "unknown";

export type UnifiedSortOption =
  | "relevance"
  | "trending"
  | "latestUpdate"
  | "rating"
  | "popularity"
  | "chapterCount";

export interface UnifiedIdentity {
  anilistId: number;
  malId?: number;
  providerIds: Record<string, string>;
  slugAliases: string[];
}

export interface UnifiedMangaTitle extends UnifiedIdentity {
  mediaType: "manga" | "manhwa" | "manhua";
  canonicalTitle: string;
  title: {
    romaji?: string;
    english?: string;
    native?: string;
    synonyms: string[];
  };
  status: UnifiedContentStatus;
  genres: string[];
  themes: string[];
  origin: string | null;
  originLanguage: string | null;
  adult: boolean;
  yearStart: number | null;
  yearEnd: number | null;
  score: number | null;
  popularity: number | null;
  coverImage: string | null;
  providersAvailable: string[];
}

export interface UnifiedMangaDetail extends UnifiedMangaTitle {
  synopsis: string | null;
  authors: string[];
  artists: string[];
  publishers: string[];
  serialization: string | null;
  totalChapters: number | null;
  totalVolumes: number | null;
  latestChapter: number | null;
  lastUpdatedAt: string | null;
  languagesAvailable: string[];
  providerCoverage: {
    available: string[];
    failed: string[];
  };
  matchConfidence: number;
  matchedBy: "anilist" | "mal" | "title" | "provider";
}

export interface UnifiedChapter {
  chapterKey: string;
  anilistId: number;
  provider: string;
  providerMangaId: string | null;
  providerChapterId: string;
  number: number | null;
  volume: number | null;
  title: string | null;
  language: string | null;
  scanlator: string | null;
  releaseDate: string | null;
  pageCount: number | null;
  canonicalOrder: number;
  isOfficial: boolean;
  isPremium: boolean;
}

export interface UnifiedReadPage {
  pageNumber: number;
  imageUrl: string;
  proxiedImageUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface UnifiedReadResponse {
  chapter: Pick<
    UnifiedChapter,
    | "chapterKey"
    | "anilistId"
    | "provider"
    | "providerChapterId"
    | "number"
    | "title"
    | "language"
  >;
  pages: UnifiedReadPage[];
  readMeta: {
    provider: string;
    fetchedAt: string;
    expiresAt: string | null;
    retryAfter: number | null;
    fallbackUsed: boolean;
    failedProviders: string[];
  };
}

export interface UnifiedSearchBase {
  mediaType: UnifiedMediaType;
  anilistId: number;
  malId?: number;
  canonicalTitle: string;
  title: {
    romaji?: string;
    english?: string;
    native?: string;
  };
  poster: string | null;
  status: UnifiedContentStatus;
  year: number | null;
  score: number | null;
  popularity: number | null;
  providersAvailable: string[];
  matchConfidence: number;
}

export interface UnifiedAnimeSearchResult extends UnifiedSearchBase {
  mediaType: "anime";
  episodes: number | null;
  duration: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
}

export interface UnifiedMangaSearchResult extends UnifiedSearchBase {
  mediaType: "manga" | "manhwa" | "manhua";
  adult: boolean;
  chapters: number | null;
  volumes: number | null;
  originLanguage: string | null;
  readingDirection: "ltr" | "rtl" | "ttb" | "unknown";
}

export type UnifiedSearchResult = UnifiedAnimeSearchResult | UnifiedMangaSearchResult;

export interface UnifiedFacetOption {
  value: string;
  label: string;
  providers: string[];
}

export interface UnifiedFacetDefinition {
  key: string;
  type: "enum" | "range" | "boolean";
  options?: UnifiedFacetOption[];
  range?: {
    min: number;
    max: number;
    step: number;
  };
  unsupportedProviders: string[];
}

export interface UnifiedFilterSchema {
  facets: UnifiedFacetDefinition[];
  sorts: UnifiedSortOption[];
}

export interface FacetValueCount {
  value: string;
  count: number;
  providers: string[];
}

export interface FacetCountGroup {
  key: string;
  counts: FacetValueCount[];
  coverageRatio: number;
  partial: boolean;
}

export interface FacetCounts {
  query: string;
  groups: FacetCountGroup[];
}
