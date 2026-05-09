const BETA_MAPPING_ENABLED = process.env.Beta_Mapping === "true";

export async function processAllSources<T = any>(sources: T[]): Promise<T[]> {
  if (!Array.isArray(sources)) return sources as any;
  return sources;
}

export async function mapProviderItem<T extends Record<string, any> = Record<string, any>>(
  item: T,
  _idType?: string,
  _idValue?: string | number,
): Promise<T> {
  if (!BETA_MAPPING_ENABLED) return item;
  if (!item || typeof item !== "object") return item;

  if (!("mapping" in item)) {
    (item as any).mapping = {};
  }

  if (!("probability" in item)) {
    (item as any).probability = false;
  }

  return item;
}

export async function mapProviderItems<T extends Record<string, any> = Record<string, any>>(
  items: T[],
): Promise<T[]> {
  if (!Array.isArray(items)) return items as any;
  if (!BETA_MAPPING_ENABLED) return items;
  return Promise.all(items.map((item) => mapProviderItem(item)));
}
