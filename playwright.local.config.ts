import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * Local-only config for environments where the Playwright-bundled Chromium cannot be downloaded
 * (the sandbox here blocks the official CDN). It reuses every committed setting but drives the
 * installed system Chrome instead. Not referenced by CI; do not add test-specific behavior here.
 */
export default defineConfig({
    ...baseConfig,
    use: {
        ...baseConfig.use,
        channel: "chrome"
    }
});
