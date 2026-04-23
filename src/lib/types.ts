export type ItemTag = {
  category: string;
  internalName: string;
  localizedCategoryName?: string;
  localizedTagName?: string;
  color?: string | null;
};

export type InventoryItem = {
  marketHashName: string;
  name: string;
  iconUrl: string;
  type: string;
  tags: ItemTag[];
  nameColor?: string | null;
  backgroundColor?: string | null;
  tradable: boolean;
  marketable: boolean;
  count: number;
  assetIds: string[];
  inspectLinkTemplate: string | null;
};

export type InventoryFile = {
  fetchedAt: number;
  steamId: string;
  appId: string;
  items: InventoryItem[];
};

export type PriceSource = "market" | "steam";

// Todos los números en la moneda destino (ya convertidos).
export type PriceEntry = {
  source: PriceSource;
  price: number | null; // precio canónico para mostrar ("desde")
  // Detalles del mercado (solo source="market"):
  min?: number | null;
  max?: number | null;
  median?: number | null;
  mean?: number | null;
  quantity?: number;
  // Detalles de Steam (solo source="steam"):
  volume?: number;
  updatedAt: number;
};

export type PricesFile = {
  currency: string;
  usdToCurrencyRate: number;
  updatedAt: number;
  prices: Record<string, PriceEntry>;
};

export type ProfileFile = {
  steamId: string | null;
  persona: string | null;
  avatarFull: string | null;
  avatarIcon: string | null;
  location: string | null;
  summary: string | null;
  memberSince: string | null;
  customUrl: string | null;
  updatedAt: number;
};

export type StoreItem = InventoryItem & {
  sourcePrice: number | null;
  storePrice: number | null;
  priceSource: PriceSource | "none";
  priceMultiplier: number;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  priceMean: number | null;
  priceQuantity: number;
  priceVolume: number;
  priceUpdatedAt: number | null;
  category: string;
  rarity: string | null;
  rarityColor: string | null;
  exterior: string | null;
  quality: string | null;
};
