/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0c",
        surface: "#141214",
        surface2: "#1c1a1c",
        border: "#2a2724",
        muted: "#8a8276",
        text: "#e8dccb",
        accent: "#d4a84c",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        display: ["'Fraunces'", "'Recoleta'", "Georgia", "serif"],
      },
      borderRadius: {
        xl2: "14px",
      },
    },
  },
  plugins: [],
};
