import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

// En GH Actions estas vienen seteadas por actions/configure-pages.
// En local no importan: si no están, base queda "/" y site vacío.
const site = process.env.SITE_URL || undefined;
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  site,
  base,
  output: "static",
  trailingSlash: "always",
  integrations: [tailwind({ applyBaseStyles: false })],
  vite: {
    server: {
      watch: { ignored: ["**/data/cache/**"] },
    },
  },
});
