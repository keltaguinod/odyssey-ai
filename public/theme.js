// Loaded synchronously in <head> so the saved theme applies before first paint.
// The CSP disallows inline scripts, which is why this lives in its own file.
(() => {
    "use strict";

    const THEME_KEY = "odyssey_theme";
    const COLORS = { dark: "#07111f", light: "#f6f8fc" };
    const systemLight = window.matchMedia("(prefers-color-scheme: light)");

    function storedTheme() {
        try {
            const value = localStorage.getItem(THEME_KEY);
            return value === "light" || value === "dark" ? value : null;
        } catch {
            return null;
        }
    }

    function apply(theme) {
        document.documentElement.dataset.theme = theme;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = COLORS[theme];
    }

    function current() {
        return storedTheme() || (systemLight.matches ? "light" : "dark");
    }

    apply(current());

    // Follow the OS setting until the user picks a theme explicitly.
    systemLight.addEventListener("change", () => {
        if (!storedTheme()) apply(current());
    });

    window.odysseyTheme = {
        current,
        set(theme) {
            try {
                localStorage.setItem(THEME_KEY, theme);
            } catch {
                // Storage may be blocked; the theme still applies for this page view.
            }
            apply(theme);
        },
    };
})();
