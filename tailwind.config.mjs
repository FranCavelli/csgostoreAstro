/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0b0d",
        surface: "#141315",
        surface2: "#1c1a1c",
        border: "#2a2724",
        muted: "#8a8276",
        text: "#e6dccb",
        accent: "#d4a84c", // dorado del león — único color de énfasis
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
    },
  },
  plugins: [],
};
