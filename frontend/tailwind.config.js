/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Core theme colors (light design with dark navy frame)
        canvas: "#0E1B30",
        panel: "#FFFFFF",
        "panel-2": "#F8FAFC",
        "panel-3": "#F1F5F9",
        "border-soft": "#E5E7EB",
        "border-strong": "#D1D5DB",
        ink: "#1A2744",
        "ink-2": "#374151",
        "ink-3": "#6B7280",
        accent: "#2563EB",
        "accent-soft": "rgba(37,99,235,0.08)",
        "accent-strong": "#1D4ED8",
        warn: "#F59E0B",
        critical: "#EF4444",
        good: "#10B981",
        amber: {
          500: "#F59E0B",
        },
        // Mapped op-* colors for backward compatibility and automated transition
        op: {
          bg: "#0E1B30",
          panel: "#FFFFFF",
          panel2: "#F8FAFC",
          panel3: "#F1F5F9",
          border: "#E5E7EB",
          borderStrong: "#D1D5DB",
          ink: "#1A2744",
          ink2: "#374151",
          ink3: "#6B7280",
          accent: "#2563EB",
          accentSoft: "rgba(37,99,235,0.08)",
          warn: "#F59E0B",
          danger: "#EF4444",
          good: "#10B981",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          '"IBM Plex Mono"',
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        // Map serif to sans (Inter) for clean enterprise look
        serif: [
          "Inter",
          "ui-sans-serif",
          "sans-serif",
        ],
      },
      fontSize: {
        micro: ["10px", { lineHeight: "14px", letterSpacing: "0.06em" }],
        meta: ["11px", { lineHeight: "16px" }],
      },
      letterSpacing: {
        tighter: "-0.025em",
        wider: "0.06em",
      },
      borderRadius: {
        DEFAULT: "8px",
        sm: "4px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
      boxShadow: {
        panel: "0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.02)",
        card: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
        "card-hover": "0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -2px rgba(0, 0, 0, 0.02)",
      },
    },
  },
  plugins: [],
};
