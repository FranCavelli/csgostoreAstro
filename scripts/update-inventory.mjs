#!/usr/bin/env node
// Background updater.
//
// Fetches:
//   - Steam inventory (paginado)
//   - Steam profile (XML)
//   - Precios desde CSGOEmpire (pagina el mercado una sola vez)
//   - Steam Market como fallback para items que CSGOEmpire no lista (con TTL)
//   - Exchange rate USD → moneda destino (solo si CURRENCY_ISO != USD)

import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = resolve(ROOT, "data/cache");
const INVENTORY_FILE = resolve(CACHE_DIR, "inventory.json");
const PRICES_FILE = resolve(CACHE_DIR, "prices.json");
const PROFILE_FILE = resolve(CACHE_DIR, "profile.json");

const CFG = {
  steamId: process.env.STEAM_ID || "76561198262015349",
  appId: process.env.STEAM_APP_ID || "730",
  contextId: "2",
  currencyIso: (process.env.CURRENCY_ISO || "USD").toUpperCase(),
  manualRate: process.env.EXCHANGE_RATE_USD ? Number(process.env.EXCHANGE_RATE_USD) : null,
  intervalMin: Number(process.env.UPDATE_INTERVAL_MINUTES || 30),
  steamFallbackTtlMin: Number(process.env.STEAM_FALLBACK_TTL_MINUTES || 720),
  steamDelayMs: Number(process.env.STEAM_REQUEST_DELAY_MS || 1500),
  empireApiKey: process.env.CSGOEMPIRE_API_KEY || "",
  empireUsdDivisor: Number(process.env.EMPIRE_USD_DIVISOR || 100),
  empireDelayMs: Number(process.env.EMPIRE_REQUEST_DELAY_MS || 1500),
  ua: "Mozilla/5.0 (sixstore-updater)",
};

const mode = process.argv.includes("--watch") ? "watch" : "once";

const log = (...a) => console.log(`[updater ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;

async function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, path);
}

async function readJsonIfExists(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function fetchWithBackoff(url, { attempts = 5, headers = {}, initialWait = 2000, maxWait = 30000 } = {}) {
  let wait = initialWait;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": CFG.ua,
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
    });
    if (res.status === 429 || res.status === 503) {
      log(`  ${res.status} rate-limited, sleeping ${wait}ms (${i}/${attempts})`);
      await sleep(wait);
      wait = Math.min(wait * 2, maxWait);
      continue;
    }
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch {}
      throw new Error(`HTTP ${res.status} ${url}${body ? ` :: ${body}` : ""}`);
    }
    return res;
  }
  throw new Error(`Gave up after ${attempts} retries: ${url}`);
}

// --- Inventario Steam --------------------------------------------------------

async function fetchInventory() {
  const base = `https://steamcommunity.com/inventory/${CFG.steamId}/${CFG.appId}/${CFG.contextId}?l=english&count=2000`;
  const merged = { success: 1, assets: [], descriptions: [] };
  const seenDesc = new Set();
  let startAssetId = null;
  let page = 0;
  while (page < 20) {
    const url = startAssetId ? `${base}&start_assetid=${startAssetId}` : base;
    log(`Inventario página ${page + 1}`);
    const res = await fetchWithBackoff(url, {
      headers: { Referer: `https://steamcommunity.com/profiles/${CFG.steamId}/inventory/` },
    });
    const data = await res.json();
    if (!data || data.success === false) {
      throw new Error("Inventory fetch failed (perfil privado o inventario vacío)");
    }
    for (const a of data.assets || []) merged.assets.push(a);
    for (const d of data.descriptions || []) {
      const k = `${d.classid}_${d.instanceid}`;
      if (seenDesc.has(k)) continue;
      seenDesc.add(k);
      merged.descriptions.push(d);
    }
    page++;
    if (!data.more_items || !data.last_assetid) break;
    startAssetId = data.last_assetid;
    await sleep(800);
  }
  log(`Inventario raw: ${merged.assets.length} assets / ${merged.descriptions.length} descriptions`);
  return merged;
}

function normalizeInventory(raw) {
  const descMap = new Map();
  for (const d of raw.descriptions || []) descMap.set(`${d.classid}_${d.instanceid}`, d);
  const byHash = new Map();
  for (const a of raw.assets || []) {
    const key = `${a.classid}_${a.instanceid}`;
    const d = descMap.get(key);
    if (!d || !d.marketable) continue;
    const hash = d.market_hash_name;
    if (!hash) continue;
    if (!byHash.has(hash)) {
      const inspectAction = (d.actions || []).find(
        (x) => typeof x?.link === "string" && x.link.includes("+csgo_econ_action_preview"),
      );
      byHash.set(hash, {
        marketHashName: hash,
        name: d.name || d.market_name || hash,
        iconUrl: d.icon_url_large || d.icon_url || "",
        type: d.type || "",
        tags: (d.tags || []).map((t) => ({
          category: t.category,
          internalName: t.internal_name,
          localizedCategoryName: t.localized_category_name,
          localizedTagName: t.localized_tag_name,
          color: t.color || null,
        })),
        nameColor: d.name_color || null,
        backgroundColor: d.background_color || null,
        tradable: !!d.tradable,
        marketable: !!d.marketable,
        count: 0,
        assetIds: [],
        inspectLinkTemplate: inspectAction?.link || null,
      });
    }
    const it = byHash.get(hash);
    it.count += Number(a.amount || 1);
    it.assetIds.push(a.assetid);
  }
  return {
    fetchedAt: Date.now(),
    steamId: CFG.steamId,
    appId: CFG.appId,
    items: [...byHash.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// --- Perfil ------------------------------------------------------------------

async function fetchProfile() {
  const url = `https://steamcommunity.com/profiles/${CFG.steamId}/?xml=1`;
  log("Perfil");
  const res = await fetchWithBackoff(url);
  const xml = await res.text();
  const pick = (tag) => {
    const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
    if (cdata) return cdata[1].trim();
    const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return plain ? plain[1].trim() : null;
  };
  return {
    steamId: pick("steamID64"),
    persona: pick("steamID"),
    avatarFull: pick("avatarFull"),
    avatarIcon: pick("avatarIcon"),
    location: pick("location"),
    summary: pick("summary"),
    memberSince: pick("memberSince"),
    customUrl: pick("customURL"),
    updatedAt: Date.now(),
  };
}

// --- Mercado CSGOEmpire (pagina todo una sola vez) --------------------------
// Query: GET /api/v2/trading/items?per_page=1000&page=N&order=market_value&sort=asc
// Solo trackeamos market_names que estén en el inventario (ahorra memoria).
// Por cada match guardamos TODOS los market_value para calcular min/max/median/mean.

async function fetchEmpireMarket(wantedSet) {
  if (!CFG.empireApiKey) {
    log("CSGOEMPIRE_API_KEY vacío → salteo CSGOEmpire");
    return new Map();
  }
  const values = new Map(); // market_name → number[]
  const perPage = 1000;
  const maxPages = 100; // límite defensivo
  let page = 1;
  let total = 0;
  let relevant = 0;

  log(`CSGOEmpire: paginando mercado (filtrando a ${wantedSet.size} items del inventario)`);
  while (page <= maxPages) {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      order: "market_value",
      sort: "asc",
    });
    const url = `https://csgoempire.com/api/v2/trading/items?${params.toString()}`;
    const res = await fetchWithBackoff(url, {
      headers: {
        Authorization: `Bearer ${CFG.empireApiKey}`,
        Accept: "application/json",
      },
      attempts: 8,
      initialWait: 5000,
      maxWait: 60000,
    });
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    if (!list.length) break;
    for (const it of list) {
      if (!it || typeof it.market_value !== "number" || !it.market_name) continue;
      if (!wantedSet.has(it.market_name)) continue;
      const arr = values.get(it.market_name);
      if (arr) arr.push(it.market_value);
      else values.set(it.market_name, [it.market_value]);
      relevant++;
    }
    total += list.length;
    log(`  page ${page}: ${list.length} listings (matches ${values.size}/${wantedSet.size}, relevant ${relevant})`);
    if (list.length < perPage) break;
    page++;
    await sleep(CFG.empireDelayMs);
  }
  log(`CSGOEmpire total: ${total} listings scanned · ${values.size}/${wantedSet.size} items con listings`);

  // Collapse a stats por market_name
  const stats = new Map();
  for (const [name, arr] of values) {
    arr.sort((a, b) => a - b);
    const min = arr[0];
    const max = arr[arr.length - 1];
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / arr.length;
    const mid = arr.length >> 1;
    const median = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    stats.set(name, { min, max, mean, median, count: arr.length });
  }
  return stats;
}

async function fetchUsdRate(iso) {
  if (iso === "USD") return 1;
  if (CFG.manualRate && CFG.manualRate > 0) {
    log(`Tasa USD→${iso}: ${CFG.manualRate} (manual)`);
    return CFG.manualRate;
  }
  const res = await fetchWithBackoff("https://open.er-api.com/v6/latest/USD", { attempts: 3 });
  const data = await res.json();
  const rate = data?.rates?.[iso];
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Sin tasa para ${iso}. Seteá EXCHANGE_RATE_USD manualmente.`);
  }
  log(`Tasa USD→${iso}: ${rate}`);
  return rate;
}

// --- Steam Market (fallback) -------------------------------------------------

function parseMoney(str) {
  if (!str || typeof str !== "string") return null;
  const cleaned = str.replace(/[^0-9.,]/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized;
  if (lastComma === -1 && lastDot === -1) normalized = cleaned;
  else if (lastComma > lastDot) normalized = cleaned.replace(/\./g, "").replace(",", ".");
  else normalized = cleaned.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

async function fetchSteamPriceUsd(hashName) {
  // Steam rate-limitea fuerte. Fail fast: 2 intentos, wait corto. Los items
  // que fallen ahora los rescatamos en la próxima corrida (TTL cache los mantiene).
  const url = `https://steamcommunity.com/market/priceoverview/?appid=${CFG.appId}&currency=1&market_hash_name=${encodeURIComponent(hashName)}`;
  const res = await fetchWithBackoff(url, { attempts: 2, initialWait: 1500, maxWait: 3000 });
  const data = await res.json();
  if (!data?.success) return null;
  return {
    lowest: parseMoney(data.lowest_price),
    median: parseMoney(data.median_price),
    volume: data.volume ? Number(String(data.volume).replace(/[^0-9]/g, "")) : 0,
  };
}

// --- Build prices ------------------------------------------------------------
// CSGOEmpire primero; Steam Market como fallback para items sin listing.

async function buildPrices(inventory, empireStats, prevPrices, rate, iso) {
  const conv = (v) => (typeof v === "number" ? round2(v * rate) : null);
  const toUsd = (coinCents) => coinCents / CFG.empireUsdDivisor;

  const out = {};
  const missing = [];
  let hits = 0;

  for (const it of inventory.items) {
    const s = empireStats.get(it.marketHashName);
    if (s && Number.isFinite(s.min)) {
      out[it.marketHashName] = {
        source: "market",
        price: conv(toUsd(s.min)),
        min: conv(toUsd(s.min)),
        max: conv(toUsd(s.max)),
        median: conv(toUsd(s.median)),
        mean: conv(toUsd(s.mean)),
        quantity: s.count,
        updatedAt: Date.now(),
      };
      hits++;
    } else {
      missing.push(it.marketHashName);
    }
  }

  log(`CSGOEmpire → con precio ${hits} · sin precio ${missing.length}`);

  // Fallback Steam con TTL para no repedir los mismos items cada corrida
  const ttlMs = CFG.steamFallbackTtlMin * 60_000;
  const now = Date.now();
  let refreshed = 0, reused = 0, failed = 0;

  for (let i = 0; i < missing.length; i++) {
    const hash = missing[i];
    const prev = prevPrices?.prices?.[hash];
    if (
      prev?.source === "steam" &&
      prev.updatedAt &&
      now - prev.updatedAt < ttlMs &&
      prev.price != null
    ) {
      out[hash] = prev;
      reused++;
      continue;
    }
    try {
      const p = await fetchSteamPriceUsd(hash);
      if (p && (p.lowest != null || p.median != null)) {
        const base = p.lowest ?? p.median;
        out[hash] = {
          source: "steam",
          price: conv(base),
          median: conv(p.median),
          volume: p.volume ?? 0,
          updatedAt: Date.now(),
        };
        refreshed++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      log(`  steam error "${hash}":`, err.message);
    }
    if ((refreshed + failed) % 25 === 0 && (refreshed + failed) > 0) {
      await writeAtomic(PRICES_FILE, {
        currency: iso, usdToCurrencyRate: rate, updatedAt: Date.now(), prices: out,
      });
    }
    await sleep(CFG.steamDelayMs);
  }

  log(`Fallback Steam → refresh ${refreshed} · reuse ${reused} · sin precio ${failed}`);
  return { currency: iso, usdToCurrencyRate: rate, updatedAt: Date.now(), prices: out };
}

// --- Runner ------------------------------------------------------------------

async function runOnce() {
  await mkdir(CACHE_DIR, { recursive: true });

  try {
    const profile = await fetchProfile();
    await writeAtomic(PROFILE_FILE, profile);
    log(`Perfil: ${profile.persona || "?"}`);
  } catch (err) {
    log("Perfil falló (no bloqueante):", err.message);
  }

  const rawInv = await fetchInventory();
  const inventory = normalizeInventory(rawInv);
  log(`Inventario normalizado: ${inventory.items.length} items`);
  await writeAtomic(INVENTORY_FILE, inventory);

  const wantedSet = new Set(inventory.items.map((it) => it.marketHashName));
  const prevPrices = await readJsonIfExists(PRICES_FILE, null);
  const [empireStats, rate] = await Promise.all([
    fetchEmpireMarket(wantedSet),
    fetchUsdRate(CFG.currencyIso),
  ]);
  const prices = await buildPrices(inventory, empireStats, prevPrices, rate, CFG.currencyIso);
  await writeAtomic(PRICES_FILE, prices);
  log(`OK`);
}

async function runWatch() {
  if (existsSync(INVENTORY_FILE)) {
    const s = await stat(INVENTORY_FILE);
    log(`Cache actual: hace ${((Date.now() - s.mtimeMs) / 60_000).toFixed(1)} min`);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await runOnce(); }
    catch (err) { log("Run falló:", err.message); }
    log(`Esperando ${CFG.intervalMin} min...`);
    await sleep(CFG.intervalMin * 60_000);
  }
}

(mode === "watch" ? runWatch() : runOnce()).catch((err) => {
  console.error(err);
  process.exit(1);
});
