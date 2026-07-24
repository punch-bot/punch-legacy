process.env.DISPLAY = process.env.DISPLAY || ":99";
process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || "/opt/pi/puppeteer-cache";
const { createRequire } = require("module");
const { mkdirSync, writeFileSync, statSync } = require("fs");
const requirePi = createRequire("/opt/pi/package.json");
const puppeteer = requirePi("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: "/root/.chrome-profile-smoke",
    defaultViewport: { width: 1280, height: 800 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    env: { ...process.env, DISPLAY: ":99" },
  });
  try {
    const page = await browser.newPage();
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
