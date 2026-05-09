declare module "string-similarity" {
  export interface Rating {
    target: string;
    rating: number;
  }

  export interface BestMatch {
    ratings: Rating[];
    bestMatch: Rating;
    bestMatchIndex: number;
  }

  export function compareTwoStrings(first: string, second: string): number;
  export function findBestMatch(mainString: string, targetStrings: string[]): BestMatch;

  const stringSimilarity: {
    compareTwoStrings: typeof compareTwoStrings;
    findBestMatch: typeof findBestMatch;
  };

  export default stringSimilarity;
}
