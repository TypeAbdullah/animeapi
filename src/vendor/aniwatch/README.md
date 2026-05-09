# HiAnime Scraper (Vendored)

This is a vendored, self-contained copy of the HiAnime scraper package. It's organized for easy modification and scaling.

## Structure

```
aniwatch/
├── config/           - Configuration (HTTP client, etc.)
├── errors/          - Error handling classes
├── types/           - TypeScript type definitions
│   ├── anime.ts     - Anime data types
│   ├── scraper.ts   - Scraper response types
│   └── index.ts     - Type re-exports
├── utils/           - Utility functions and constants
│   └── constants.ts - URLs, filters, search parameters
├── scrapers/        - (Reserved for future modularization)
├── index.ts         - Main entry point (clean exports)
├── index.js         - Compiled scraper implementation (DO NOT EDIT)
└── LICENSE          - MIT License
```

## Usage

```typescript
import { HiAnime, Servers } from "../vendor/aniwatch/index.js";

const scraper = new HiAnime.Scraper();

// Get anime info
const info = await scraper.getInfo("steinsgate-3");

// Get episodes with sources
const sources = await scraper.getEpisodeSources(
    "steinsgate-3?ep=230",
    Servers.MegaCloud,
    "sub"
);
```

## Editing & Extending

- **Types**: Modify `types/` to add new types or change response structures
- **Constants**: Update `utils/constants.ts` to change URLs, filters, or configuration
- **Errors**: Enhance `errors/HiAnimeError.ts` for better error handling
- **Config**: Adjust `config/client.ts` for HTTP client settings

## Important Notes

- `index.js` contains the compiled scraper logic - it's auto-generated and should not be manually edited
- All TypeScript sources (`.ts` files) are compiled by your build system
- The module is fully self-contained with no external aniwatch dependency
- Dependencies: `axios`, `cheerio`, `crypto-js` (should be in TatakaiCore package.json)
