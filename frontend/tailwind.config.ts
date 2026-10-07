import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Same values as the CSS variables in globals.css. Hex here so opacity modifiers work.
      colors: {
        paper: "#e9ede4",
        stock: "#f7f8f3",
        ink: "#1a2130",
        muted: "#556070",
        rule: "#c9cfc2",
        signal: "#ffc93c",
        money: "#1f5fd6",
        stamp: "#d7362a",
        board: "#2b3446",
      },
      fontFamily: {
        sans: ["'Archivo Variable'", "Archivo", "system-ui", "sans-serif"],
      },
      maxWidth: { page: "1200px" },
    },
  },
  plugins: [],
};
export default config;
