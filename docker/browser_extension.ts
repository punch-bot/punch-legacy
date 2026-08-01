/**
 * Built-in headful Chromium tools for Punch (Pi extension, not MCP), powered by Playwright.
 * Screenshots return image content so pi-gateway can auto-attach them to Discord.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire("/opt/pi/package.json");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chromium } = require("playwright") as typeof import("playwright");

const SCREENSHOT_DIR = "/work/screenshots";
const USER_DATA_DIR = "/root/.chrome-profile";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1280,800",
  "--no-first-run",
  "--no-default-browser-check",
];

// A crashed Chromium leaves stale singleton locks in the profile dir. A headful
// launch then refuses with "The profile appears to be in use by another Chromium
// process" — clear them before launching.
const LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "chrome_debug.log"];

type BrowserContext = Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
type Page = import("playwright").Page;

let contextPromise: Promise<BrowserContext> | null = null;

function clearSingletonLocks(): void {
  for (const name of LOCK_FILES) {
    rmSync(join(USER_DATA_DIR, name), { force: true });
  }
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

async function launchContext(): Promise<BrowserContext> {
  clearSingletonLocks();
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: DEFAULT_VIEWPORT,
      args: LAUNCH_ARGS,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":99",
      },
    });
  } catch (err) {
    // A concurrent/leftover Chromium may still hold the profile; clear and retry once.
    clearSingletonLocks();
    return chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: DEFAULT_VIEWPORT,
      args: LAUNCH_ARGS,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":99",
      },
    });
  }
}

async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = launchContext().catch((err) => {
      contextPromise = null;
      throw err;
    });
    const ctx = await contextPromise;
    // Used by the webfetch extension's JS-rendered-page fallback.
    (globalThis as any).__pi_browser = ctx;
  }
  return contextPromise;
}

async function getPage(): Promise<Page> {
  const context = await getContext();
  const pages = context.pages();
  const page = pages[0] && !pages[0].isClosed() ? pages[0] : await context.newPage();
  await page.setViewportSize(DEFAULT_VIEWPORT);
  return page;
}

function safeName(name: string): string {
  const base = String(name || "screenshot")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "screenshot";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "puppeteer_navigate",
    label: "Browser navigate",
    description: "Navigate the sandbox browser to a URL (headful Chromium on DISPLAY=:99)",
    promptSnippet: "Open a URL in the browser",
    promptGuidelines: [
      "Use puppeteer_navigate before screenshot/click/fill on a page.",
      "Screenshots from puppeteer_screenshot are auto-attached to Discord — do not also emit <attachment> for the same PNG unless asked.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to open" }),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      const response = await page.goto(String(args.url), {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const status = response?.status() ?? null;
      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      return textResult(
        `Navigated to ${finalUrl}` +
          (title ? ` (title: ${title})` : "") +
          (status != null ? ` [HTTP ${status}]` : ""),
        { url: finalUrl, title, status },
      );
    },
  });

  pi.registerTool({
    name: "puppeteer_screenshot",
    label: "Browser screenshot",
    description:
      "Capture a PNG screenshot of the current page (or a CSS selector). Image is returned for Discord auto-attach and saved under /work/screenshots/.",
    promptSnippet: "Screenshot the browser page for the user",
    promptGuidelines: [
      "Prefer this over bash/imagemagick for page captures.",
      "Every screenshot is auto-attached to the Discord reply — say briefly what it shows.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Filename stem for the screenshot (no extension)" }),
      selector: Type.Optional(
        Type.String({ description: "Optional CSS selector to screenshot instead of the full page viewport" }),
      ),
      width: Type.Optional(Type.Number({ description: "Viewport width (default 1280)" })),
      height: Type.Optional(Type.Number({ description: "Viewport height (default 800)" })),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      const width = Number(args.width) > 0 ? Math.floor(Number(args.width)) : DEFAULT_VIEWPORT.width;
      const height = Number(args.height) > 0 ? Math.floor(Number(args.height)) : DEFAULT_VIEWPORT.height;
      await page.setViewportSize({ width, height });

      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const stem = safeName(args.name);
      const filePath = join(SCREENSHOT_DIR, `${stem}.png`);

      let buffer: Buffer;
      if (args.selector) {
        const locator = page.locator(String(args.selector));
        await locator.waitFor({ state: "attached", timeout: 15000 });
        buffer = await locator.screenshot({ path: filePath, type: "png" });
      } else {
        buffer = await page.screenshot({ path: filePath, type: "png" });
      }

      const b64 = buffer.toString("base64");
      const url = page.url();

      return {
        content: [
          {
            type: "text" as const,
            text: `Screenshot saved to ${filePath} (${buffer.length} bytes, page: ${url})`,
          },
          {
            type: "image" as const,
            data: b64,
            mimeType: "image/png",
          },
        ],
        details: { path: filePath, bytes: buffer.length, url, name: stem },
      };
    },
  });

  pi.registerTool({
    name: "puppeteer_click",
    label: "Browser click",
    description: "Click an element matching a CSS selector",
    promptSnippet: "Click a page element",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector to click" }),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      await page.locator(String(args.selector)).click({ delay: 20 });
      return textResult(`Clicked ${args.selector}`, { selector: args.selector });
    },
  });

  pi.registerTool({
    name: "puppeteer_fill",
    label: "Browser fill",
    description: "Clear and type into an input/textarea matching a CSS selector",
    promptSnippet: "Fill a form field",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector for the input" }),
      value: Type.String({ description: "Text to type" }),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      const selector = String(args.selector);
      await page.locator(selector).fill(String(args.value));
      return textResult(`Filled ${selector}`, { selector, valueLength: String(args.value).length });
    },
  });

  pi.registerTool({
    name: "puppeteer_select",
    label: "Browser select",
    description: "Choose an option on a <select> element",
    promptSnippet: "Select a dropdown option",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector for the <select>" }),
      value: Type.String({ description: "option value to select" }),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      const selected = await page.selectOption(String(args.selector), String(args.value));
      return textResult(`Selected ${JSON.stringify(selected)} on ${args.selector}`, {
        selector: args.selector,
        value: args.value,
        selected,
      });
    },
  });

  pi.registerTool({
    name: "puppeteer_hover",
    label: "Browser hover",
    description: "Hover an element matching a CSS selector",
    promptSnippet: "Hover a page element",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector to hover" }),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      await page.locator(String(args.selector)).hover();
      return textResult(`Hovered ${args.selector}`, { selector: args.selector });
    },
  });

  pi.registerTool({
    name: "puppeteer_evaluate",
    label: "Browser evaluate",
    description: "Run JavaScript in the page context and return the JSON-serialized result",
    promptSnippet: "Run JS in the browser page",
    parameters: Type.Object({
      script: Type.String({
        description: "JavaScript expression or function body; return value is JSON-serialized",
      }),
    }),
    async execute(_toolCallId, args) {
      const page = await getPage();
      const script = String(args.script);
      // Evaluate user script in page context (same idea as MCP server-puppeteer).
      const result = await page.evaluate((code) => {
        // eslint-disable-next-line no-eval
        return eval(code);
      }, script);
      let text: string;
      try {
        text = JSON.stringify(result, null, 2);
      } catch {
        text = String(result);
      }
      return textResult(text || "(undefined)", { typeof: typeof result });
    },
  });
}
