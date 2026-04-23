import { resolve } from "node:path";

export const ROOT = process.cwd();
export const DATA_DIR = resolve(ROOT, "data");
export const CACHE_DIR = resolve(DATA_DIR, "cache");
export const INVENTORY_FILE = resolve(CACHE_DIR, "inventory.json");
export const PRICES_FILE = resolve(CACHE_DIR, "prices.json");
export const PROFILE_FILE = resolve(CACHE_DIR, "profile.json");
