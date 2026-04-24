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
  steamFallbackTtlMin: Number(process.env.STEAM_FALLBACK_TTL_MINUTES || 2880),
  steamDelayMs: Number(process.env.STEAM_REQUEST_DELAY_MS || 3000),
  // Cuántos 429/errores seguidos de Steam cortan la pasada de fallback
  // en una corrida (evita quemar 20 min cuando Steam bloquea la IP).
  steamBreakerThreshold: Number(process.env.STEAM_BREAKER_THRESHOLD || 8),
  empireApiKey: process.env.CSGOEMPIRE_API_KEY || "",
  empireUsdDivisor: Number(process.env.EMPIRE_USD_DIVISOR || 100),
  empireDelayMs: Number(process.env.EMPIRE_REQUEST_DELAY_MS || 1500),
  // Espera entre pasadas consecutivas cuando la primera muere por rate-limit.
  empireSecondPassWaitMs: Number(process.env.EMPIRE_SECOND_PASS_WAIT_MS || 60000),
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
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
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
    } catch (err) {
      lastErr = err;
      // HTTP 4xx/5xx (no-retry) se propagan tal cual
      if (err.message?.startsWith("HTTP ")) throw err;
      // Errores de red/DNS/socket reset se reintentan con backoff
      if (i >= attempts) break;
      log(`  net error (${err.code || err.message}), sleeping ${wait}ms (${i}/${attempts})`);
      await sleep(wait);
      wait = Math.min(wait * 2, maxWait);
    }
  }
  throw new Error(`Gave up after ${attempts} retries: ${url}${lastErr ? ` :: ${lastErr.message}` : ""}`);
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

// Pagina el mercado empezando en `startPage`. Si una página falla tras todos
// los retries, devuelve los resultados parciales y la página que quedó pendiente
// (hadError: true, lastPage: N) para poder retomar en una segunda pasada.
async function fetchEmpireMarketPass(wantedSet, { startPage = 1, label = "pass 1" } = {}) {
  const values = new Map(); // market_name → number[]
  const perPage = 1000;
  const maxPages = 100;
  let page = startPage;
  let total = 0;
  let hadError = false;

  log(`CSGOEmpire [${label}]: paginando desde página ${startPage} (${wantedSet.size} items buscados)`);
  while (page <= maxPages) {
    let data;
    try {
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        order: "market_value",
        sort: "asc",
      });
      const url = `https://csgoempire.com/api/v2/trading/items?${params.toString()}`;
      const res = await fetchWithBackoff(url, {
        headers: { Authorization: `Bearer ${CFG.empireApiKey}`, Accept: "application/json" },
        attempts: 8,
        initialWait: 5000,
        maxWait: 60000,
      });
      data = await res.json();
    } catch (err) {
      // Error duro: guardamos lo que tenemos y marcamos la página que falló.
      log(`  page ${page} falló: ${err.message} — corto aquí con parciales`);
      hadError = true;
      break;
    }
    const list = Array.isArray(data?.data) ? data.data : [];
    if (!list.length) break;
    for (const it of list) {
      if (!it || typeof it.market_value !== "number" || !it.market_name) continue;
      if (!wantedSet.has(it.market_name)) continue;
      const arr = values.get(it.market_name);
      if (arr) arr.push(it.market_value);
      else values.set(it.market_name, [it.market_value]);
    }
    total += list.length;
    log(`  page ${page}: ${list.length} listings (matches ${values.size}/${wantedSet.size})`);
    if (list.length < perPage) break;
    page++;
    await sleep(CFG.empireDelayMs);
  }
  log(`CSGOEmpire [${label}]: ${total} listings · ${values.size}/${wantedSet.size}${hadError ? " (parcial)" : ""}`);
  return { values, hadError, lastPage: page };
}

// Dos pasadas: si la primera muere por rate-limit, esperamos y retomamos
// desde la página que falló. El merge preserva los valores ya recolectados
// (no re-escanea páginas, así que no hay duplicados).
async function fetchEmpireMarket(wantedSet) {
  if (!CFG.empireApiKey) {
    log("CSGOEMPIRE_API_KEY vacío → salteo CSGOEmpire");
    return new Map();
  }
  const allValues = new Map();
  const merge = (src) => {
    for (const [k, v] of src) {
      const cur = allValues.get(k);
      if (cur) cur.push(...v);
      else allValues.set(k, [...v]);
    }
  };

  const p1 = await fetchEmpireMarketPass(wantedSet, { startPage: 1, label: "pass 1" });
  merge(p1.values);

  if (p1.hadError) {
    log(`CSGOEmpire: esperando ${Math.round(CFG.empireSecondPassWaitMs / 1000)}s antes de 2ª pasada desde página ${p1.lastPage}`);
    await sleep(CFG.empireSecondPassWaitMs);
    const p2 = await fetchEmpireMarketPass(wantedSet, { startPage: p1.lastPage, label: "pass 2" });
    merge(p2.values);
    if (p2.hadError) {
      log(`CSGOEmpire: 2ª pasada también incompleta, Steam fallback rescata el resto`);
    }
  }

  // Collapse a stats por market_name
  const stats = new Map();
  for (const [name, arr] of allValues) {
    arr.sort((a, b) => a - b);
    const min = arr[0];
    const max = arr[arr.length - 1];
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / arr.length;
    const mid = arr.length >> 1;
    const median = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    stats.set(name, { min, max, mean, median, count: arr.length });
  }
  log(`CSGOEmpire total final: ${stats.size}/${wantedSet.size} items con listings`);
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
  // Steam rate-limitea fuerte, especialmente desde IPs cloud (GH Actions).
  // 4 intentos con backoff largo — si la IP no está bloqueada al menos
  // algunos items pasan. Los que fallen se cachean vía TTL igual.
  const url = `https://steamcommunity.com/market/priceoverview/?appid=${CFG.appId}&currency=1&market_hash_name=${encodeURIComponent(hashName)}`;
  const res = await fetchWithBackoff(url, { attempts: 4, initialWait: 3000, maxWait: 30000 });
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
  let refreshed = 0, reused = 0, failed = 0, stale = 0;
  let consecFails = 0;
  let breakerTripped = false;

  for (let i = 0; i < missing.length; i++) {
    const hash = missing[i];
    const prev = prevPrices?.prices?.[hash];

    // Reuso dentro del TTL: no molestamos a Steam.
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

    // Circuit breaker: si Steam nos rompe N veces seguidas, salteamos el
    // resto de la pasada y dejamos que la próxima corrida lo reintente.
    // Los items que tenían precio Steam previo (aunque vencido) se mantienen.
    if (breakerTripped) {
      if (prev?.source === "steam" && prev.price != null) {
        out[hash] = prev;
        stale++;
      } else {
        failed++;
      }
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
        consecFails = 0;
      } else if (prev?.source === "steam" && prev.price != null) {
        // Steam respondió pero sin datos útiles → mantenemos el previo
        out[hash] = prev;
        stale++;
      } else {
        failed++;
      }
    } catch (err) {
      consecFails++;
      if (prev?.source === "steam" && prev.price != null) {
        out[hash] = prev;
        stale++;
      } else {
        failed++;
      }
      log(`  steam error "${hash}" (${consecFails} seguidos):`, err.message);
      if (consecFails >= CFG.steamBreakerThreshold) {
        log(`  Steam tiró ${consecFails} errores seguidos — corto fallback, reuso precios previos`);
        breakerTripped = true;
      }
    }

    if ((refreshed + failed + stale) % 25 === 0 && (refreshed + failed + stale) > 0) {
      await writeAtomic(PRICES_FILE, {
        currency: iso, usdToCurrencyRate: rate, updatedAt: Date.now(), prices: out,
      });
    }
    await sleep(CFG.steamDelayMs);
  }

  log(`Fallback Steam → refresh ${refreshed} · reuse ${reused} · stale ${stale} · sin precio ${failed}`);
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
  let inventory = normalizeInventory(rawInv);
  log(`Inventario normalizado: ${inventory.items.length} items`);

  // Safeguard: Steam a veces responde "more_items: false" en medio de la
  // paginación y nos devuelve un inventario truncado. Si el nuevo tiene
  // <90% del previo, asumimos que fue fetch parcial y mantenemos el viejo.
  const prevInv = await readJsonIfExists(INVENTORY_FILE, null);
  if (
    prevInv?.items?.length &&
    inventory.items.length > 0 &&
    inventory.items.length < prevInv.items.length * 0.9
  ) {
    log(
      `⚠ Inventario nuevo ${inventory.items.length} < 90% del previo ${prevInv.items.length} — mantengo el previo`,
    );
    inventory = { ...prevInv, fetchedAt: Date.now() };
  }
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
