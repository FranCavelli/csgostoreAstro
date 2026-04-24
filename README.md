# sixstore

Tienda de skins CS2 de **[Sixbulletss Store](https://steamcommunity.com/id/sixbulletss)**. Astro en modo **estático** (SSG) — se despliega en GitHub Pages. Una GitHub Action corre cada 2 horas, baja inventario + precios + perfil, y rearma el sitio.

## Cómo funciona

```
GitHub Action (cron 2h)
  └─ npm run update   → data/cache/{inventory,prices,profile}.json
  └─ npm run build    → dist/ (HTML estático, una página por skin)
  └─ deploy-pages     → https://<user>.github.io/<repo>/
```

- Sin servidor, sin API keys, sin cookies.
- Precios cacheados en el HTML mismo: las páginas cargan instantáneo.
- Actualizar precios = rebuild del sitio (lo dispara el cron).

## Desplegar en GitHub Pages

1. **Crear el repo** y pushear el código.
2. En **Settings → Pages** elegir **Source: GitHub Actions**.
3. En **Settings → Secrets and variables → Actions**:
   - **Secret** (obligatorio): `CSGOEMPIRE_API_KEY` — key de https://csgoempire.com/trading/apikey
   - **Variables** (opcionales):
     - `STEAM_ID` — SteamID64 (default `76561198262015349`)
     - `STEAM_VANITY` — custom URL (default `sixbulletss`)
     - `CURRENCY_ISO` — `USD`, `ARS`, `EUR`... (default `USD`)
     - `STEAM_CURRENCY` — código Steam (default `1` = USD)
     - `MARKET_MULTIPLIER` — markup sobre precio de CSGOEmpire (default `1`)
     - `EMPIRE_USD_DIVISOR` — divisor coin-cents → USD (default `100`)
     - `EXCHANGE_RATE_USD` — tasa USD→moneda fija (vacío = live; solo si ISO != USD)
4. Push a `main` o **Run workflow** manual → primer deploy.
5. Listo en `https://<usuario>.github.io/<repo>/`.

El cron está en `.github/workflows/deploy.yml` (`cron: "0 */2 * * *"`, cada 2 hs). CSGOEmpire tiene rate limit de 120 req/10s, así que cualquier frecuencia anda bien.

## Local

```bash
npm install
npm run update        # baja datos (crea data/cache/*.json)
npm run dev           # http://localhost:4321
```

Si cambiás precios/inventario, `npm run update:build` hace ambas cosas.

## Configuración (vía .env en local)

Igual que los variables de Actions — podés armar `.env` desde `.env.example`.

| Variable | Default | Qué hace |
|---|---|---|
| `STEAM_ID` | `76561198262015349` | SteamID64 |
| `STEAM_VANITY` | `sixbulletss` | custom URL para links |
| `CSGOEMPIRE_API_KEY` | _(vacío)_ | **obligatorio** — API key de CSGOEmpire |
| `EMPIRE_USD_DIVISOR` | `100` | divisor para convertir `market_value` (coin-cents) a USD |
| `MARKET_MULTIPLIER` | `1` | markup sobre precio de CSGOEmpire |
| `CURRENCY_ISO` | `USD` | moneda destino (USD, EUR, ARS, BRL...) |
| `STEAM_CURRENCY` | `1` | código Steam — solo para locale de formato |
| `EXCHANGE_RATE_USD` | _(vacío)_ | tasa USD→moneda fija; vacío = live (solo si ISO != USD) |
| `UPDATE_INTERVAL_MINUTES` | `30` | solo relevante si corrés `npm run updater` en loop local |

## Estructura

```
.github/workflows/deploy.yml   ← cron + build + deploy
scripts/update-inventory.mjs   ← fetch Steam inventory + CSGOEmpire prices + tasa USD
data/cache/*.json              ← artefactos del updater (gitignored)
src/
  lib/
    store.ts, config.ts, i18n.ts, paths.ts, types.ts
  layouts/Layout.astro          ← ClientRouter + favicon (avatar Steam)
  components/
    ItemCard.astro              ← transition:name para morph
    Filters.astro                ← auto-submit en change/enter
    Pagination.astro
  pages/
    index.astro                  ← catálogo con filtros/paginación
    item/[slug].astro            ← getStaticPaths → 1 HTML por skin,
                                    con expand animation + view transition
```

## Notas

- **Inventario público requerido**: si el perfil tiene inventario privado, la Action falla. Configuración → Privacidad → Inventario → Público.
- **Datacenter IPs**: Steam rate-limita más duro a IPs de GitHub Actions. El updater ya tiene backoff exponencial y TTL en el fallback Steam, pero si ves muchos `429`, subí el cron a cada 4 hs.
- **Sin admin UI**: precios se controlan en Actions Variables. Cambiar uno y re-run del workflow.
