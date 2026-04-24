import type { APIRoute } from "astro";
import {
  loadInventory,
  loadPrices,
  buildStoreItems,
  itemSlug,
  itemDetailUrl,
  steamIconUrl,
  formatMoney,
  collectCategories,
  collectRarities,
} from "~/lib/store";

// Astro renderiza esta ruta al hacer `astro build` y genera /items.json
// (estático, cacheable). El cliente lo fetchea una vez y filtra/ordena en memoria.
export const GET: APIRoute = async () => {
  const [inv, prices] = await Promise.all([loadInventory(), loadPrices()]);
  const all = buildStoreItems(inv, prices);

  const items = all.map((it) => ({
    slug: itemSlug(it.marketHashName),
    href: itemDetailUrl(it.marketHashName),
    name: it.name,
    icon: steamIconUrl(it.iconUrl, 256),
    price: it.storePrice,
    priceFmt: formatMoney(it.storePrice),
    category: it.category,
    rarity: it.rarity,
    rarityColor: it.rarityColor,
    exterior: it.exterior,
    quality: it.quality,
    count: it.count,
  }));

  const categories = collectCategories(all);
  const rarities = collectRarities(all);

  return new Response(
    JSON.stringify({
      items,
      categories,
      rarities,
      // Timestamp real del último fetch de precios. El cliente lo usa para
      // mostrar "hace X min" en vivo (el valor server-side queda baked en
      // el HTML y en GH Pages siempre dice ~0 porque el build corre justo
      // después del fetch).
      updatedAt: prices.updatedAt || null,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};
