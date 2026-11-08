import { useEffect, useState } from "react";

export type Theme = "auto" | "light" | "dark";
export type Density = "comfortable" | "compact";

/** Theme and spacing are each person's choice, kept on this computer. index.html applies them before the first paint. */
export function useAppearance() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = window.localStorage.getItem("paidloop.theme");
    return stored === "light" || stored === "dark" ? stored : "auto";
  });
  const [density, setDensity] = useState<Density>(() => (window.localStorage.getItem("paidloop.density") === "compact" ? "compact" : "comfortable"));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", theme === "dark" || (theme === "auto" && media.matches) ? "dark" : "light");
    apply();
    window.localStorage.setItem("paidloop.theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    window.localStorage.setItem("paidloop.density", density);
  }, [density]);

  return { theme, setTheme, density, setDensity };
}

export type Appearance = ReturnType<typeof useAppearance>;
