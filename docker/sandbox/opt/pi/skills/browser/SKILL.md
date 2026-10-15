---
name: browser
description: Use built-in headless Chromium (puppeteer_*) tools for interactive pages
---

# Browser

- use the built-in headless Chromium tools for interactive pages. use curl or bash for simple HTTP requests that do not need a browser.
- when you take a screenshot with `puppeteer_screenshot`, the file is saved to `/work/screenshots/`. to show it in Discord, append an `<attachment>` tag to your reply with the file path. do NOT rely on automatic attachment — always tag it explicitly:

```text
<attachment path="screenshots/filename.png"></attachment>
```
