import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { INVENTORY_FILE, PRICES_FILE, PROFILE_FILE } from "./paths";
import { config } from "./config";
import {
  translateType,
  translateExterior,
  translateRarity,
  translateQuality,
} from "./i18n";
import type {
  InventoryFile,
  PricesFile,
  ProfileFile,
  StoreItem,
  InventoryItem,
} from "./types";

type Cached<T> = { mtimeMs: number; value: T };
const cache: {
  inventory?: Cached<InventoryFile>;
  prices?: Cached<PricesFile>;
  profile?: Cached<ProfileFile>;
} = {};

async function loadCached<T>(
  slot: keyof typeof cache,
  file: string,
  fallback: T,
): Promise<T> {
  let mtimeMs = 0;
  try {
    const s = await stat(file);
    mtimeMs = s.mtimeMs;
  } catch {
    return fallback;
  }
  const hit = cache[slot] as Cached<T> | undefined;
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const txt = await readFile(file, "utf8");
  const value = JSON.parse(txt) as T;
  cache[slot] = { mtimeMs, value } as Cached<unknown> as (typeof cache)[typeof slot];
  return value;
}

export async function loadInventory(): Promise<InventoryFile> {
  return loadCached<InventoryFile>("inventory", INVENTORY_FILE, {
    fetchedAt: 0,
    steamId: "",
    appId: "730",
    items: [],
  });
}

export async function loadPrices(): Promise<PricesFile> {
  return loadCached<PricesFile>("prices", PRICES_FILE, {
    currency: config.currencyIso,
    usdToCurrencyRate: 1,
    updatedAt: 0,
    prices: {},
  });
}

export async function loadProfile(): Promise<ProfileFile> {
  return loadCached<ProfileFile>("profile", PROFILE_FILE, {
    steamId: null,
    persona: null,
    avatarFull: null,
    avatarIcon: null,
    location: null,
    summary: null,
    memberSince: null,
    customUrl: null,
    updatedAt: 0,
  });
}

function pickTag(item: InventoryItem, category: string): string | null {
  const t = item.tags.find((t) => t.category === category);
  return t?.localizedTagName || t?.internalName || null;
}

function pickTagColor(item: InventoryItem, category: string): string | null {
  const t = item.tags.find((t) => t.category === category);
  const c = t?.color || null;
  return c && !c.startsWith("#") ? `#${c}` : c;
}

export function buildStoreItems(
  inventory: InventoryFile,
  pricesFile: PricesFile,
): StoreItem[] {
  const out: StoreItem[] = [];
  for (const it of inventory.items) {
    const p = pricesFile.prices[it.marketHashName];
    const sourcePrice = p?.price ?? null;
    const mult = config.marketMultiplier;
    const storePrice = sourcePrice != null ? round2(sourcePrice * mult) : null;

    out.push({
      ...it,
      sourcePrice,
      storePrice,
      priceSource: p?.source ?? "none",
      priceMultiplier: mult,
      priceMin: p?.min ?? null,
      priceMax: p?.max ?? null,
      priceMedian: p?.median ?? null,
      priceMean: p?.mean ?? null,
      priceQuantity: p?.quantity ?? 0,
      priceVolume: p?.volume ?? 0,
      priceUpdatedAt: p?.updatedAt ?? null,
      category: translateType(pickTag(it, "Type") || it.type),
      rarity: translateRarity(pickTag(it, "Rarity")),
      rarityColor: pickTagColor(it, "Rarity"),
      exterior: translateExterior(pickTag(it, "Exterior")),
      quality: translateQuality(pickTag(it, "Quality")),
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type FilterQuery = {
  category?: string | null;
  rarity?: string | null;
  q?: string | null;
  sort?: "price-asc" | "price-desc" | "name" | "rarity" | null;
};

export function filterItems(items: StoreItem[], q: FilterQuery): StoreItem[] {
  const needle = (q.q || "").trim().toLowerCase();
  let out = items.filter((it) => {
    if (q.category && q.category !== "all" && it.category !== q.category) return false;
    if (q.rarity && q.rarity !== "all" && it.rarity !== q.rarity) return false;
    if (needle && !it.name.toLowerCase().includes(needle)) return false;
    return true;
  });
  switch (q.sort) {
    case "price-asc":
      out.sort((a, b) => priceKey(a) - priceKey(b));
      break;
    case "price-desc":
      out.sort((a, b) => priceKey(b) - priceKey(a));
      break;
    case "rarity":
      out.sort(
        (a, b) =>
          (a.rarity || "").localeCompare(b.rarity || "") || a.name.localeCompare(b.name),
      );
      break;
    case "name":
    default:
      out.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

function priceKey(it: StoreItem): number {
  return it.storePrice ?? Number.POSITIVE_INFINITY;
}

export type Paged<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export function paginate<T>(items: T[], page: number, perPage: number): Paged<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page | 0), totalPages);
  const start = (p - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page: p,
    perPage,
    total,
    totalPages,
  };
}

export function collectCategories(
  items: StoreItem[],
): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) m.set(it.category, (m.get(it.category) || 0) + 1);
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function collectRarities(
  items: StoreItem[],
): { name: string; color: string | null; count: number }[] {
  const m = new Map<string, { color: string | null; count: number }>();
  for (const it of items) {
    if (!it.rarity) continue;
    const cur = m.get(it.rarity) || { color: it.rarityColor, count: 0 };
    cur.count++;
    m.set(it.rarity, cur);
  }
  return [...m.entries()]
    .map(([name, v]) => ({ name, color: v.color, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

export function steamIconUrl(iconUrl: string, size = 256): string {
  if (!iconUrl) return "";
  return `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}/${size}fx${size}f`;
}

export function steamMarketUrl(marketHashName: string, appId = config.appId): string {
  return `https://steamcommunity.com/market/listings/${appId}/${encodeURIComponent(marketHashName)}`;
}

// Slug URL-safe y estable para nombres de market con espacios, |, (), ★, ™, etc.
// slugified-name + 8 chars de sha1 para evitar colisiones entre variantes.
export function itemSlug(marketHashName: string): string {
  const base = marketHashName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  const hash = createHash("sha1").update(marketHashName).digest("hex").slice(0, 8);
  return base ? `${base}-${hash}` : hash;
}

// Antepone BASE_URL para que los links funcionen bajo /repo-name en GitHub Pages.
function withBase(path: string): string {
  const b = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${b}${path.startsWith("/") ? path : `/${path}`}`;
}

export function homeUrl(): string {
  return withBase("/");
}

// Resuelve los placeholders del link de inspección que Steam devuelve en
// descriptions[].actions[]. Requiere el steamID del dueño y un assetid concreto.
export function resolveInspectLink(
  template: string | null,
  steamId: string,
  assetId: string | undefined,
): string | null {
  if (!template || !assetId) return null;
  return template
    .replace("%owner_steamid%", steamId)
    .replace("%assetid%", assetId);
}

export function itemDetailUrl(marketHashName: string): string {
  return withBase(`/item/${itemSlug(marketHashName)}/`);
}

export function formatMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  const code = config.currencyCode;
  const iso = config.currencyIso || CURRENCY_ISO[code] || "USD";
  const locale = CURRENCY_LOCALE[code] || "en-US";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: iso }).format(n);
  } catch {
    return `${iso} ${n.toFixed(2)}`;
  }
}

const CURRENCY_ISO: Record<number, string> = {
  1: "USD", 2: "GBP", 3: "EUR", 5: "RUB", 7: "BRL", 34: "ARS", 20: "MXN", 23: "CLP",
};
const CURRENCY_LOCALE: Record<number, string> = {
  1: "en-US", 2: "en-GB", 3: "de-DE", 5: "ru-RU", 7: "pt-BR", 34: "es-AR", 20: "es-MX", 23: "es-CL",
};

export { config };
