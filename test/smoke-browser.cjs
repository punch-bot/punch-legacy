const { createRequire } = require("module");
const { mkdirSync, writeFileSync, statSync } = require("fs");
const requirePi = createRequire("/opt/pi/package.json");
const { chromium } = requirePi("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  try {
    const context = await chromium.launchPersistentContext("/root/.chrome-profile-smoke", {
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    mkdirSync("/work/screenshots", { recursive: true });
    const buf = await page.screenshot({ type: "png" });
    writeFileSync("/work/screenshots/smoke-example.png", buf);
    const title = await page.title();
    const st = statSync("/work/screenshots/smoke-example.png");
    console.log(
      JSON.stringify({
        ok: true,
        title,
        bytes: st.size,
        path: "/work/screenshots/smoke-example.png",
      }),
    );
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error("SMOKE_FAIL", e && e.stack ? e.stack : e);
  process.exit(1);
});
