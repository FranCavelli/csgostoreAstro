// Config de runtime. Todo desde .env.

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = {
  steamId: process.env.STEAM_ID || "76561198262015349",
  steamVanity: process.env.STEAM_VANITY || "sixbulletss",
  appId: process.env.STEAM_APP_ID || "730",
  // Markup sobre el precio de CSGOEmpire. 1 = sin markup.
  marketMultiplier: num(process.env.MARKET_MULTIPLIER, 1),
  currencyCode: num(process.env.STEAM_CURRENCY, 1),
  currencyIso: (process.env.CURRENCY_ISO || "USD").toUpperCase(),
  updateIntervalMinutes: num(process.env.UPDATE_INTERVAL_MINUTES, 30),
};

export type AppConfig = typeof config;
