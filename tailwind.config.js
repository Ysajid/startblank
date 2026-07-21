/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        ui: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
        "write-serif": ["Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Georgia", "serif"],
        "write-sans": ["Charter", "Avenir Next", "-apple-system", "Segoe UI", "sans-serif"],
        "write-mono": ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
