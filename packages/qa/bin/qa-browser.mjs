#!/usr/bin/env node
// Matrix agent QA lane, web driver: the QA agent's only browser tool. Connects over CDP to the
// lane's dedicated headless Chrome (own profile, 127.0.0.1 port chosen by the lane, never the
// owner's 9222/9223) and acts on the tested page. Navigation is limited to the target origin.
// Env (set by the lane's wrapper): QA_CDP, QA_ORIGIN, QA_OUT, QA_EVENTS.
// `record` (lane-only) stays connected and appends console errors / page errors / failed requests
// to QA_EVENTS as JSON lines; `console` and `network` print them for the agent.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [cmd, ...args] = process.argv.slice(2);
const { QA_CDP, QA_ORIGIN, QA_OUT, QA_EVENTS } = process.env;
const fail = (m, code = 2) => {
  console.error(m);
  process.exit(code);
};
if (!QA_CDP || !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(QA_CDP)) fail("lane CDP endpoint missing");
const origin = new URL(QA_ORIGIN ?? "http://invalid").origin;

const HELP = `usage: ./qa-browser <command>
  open <url|/path>        navigate (target origin only)
  snapshot                accessibility tree of the page (find roles/names to click)
  click <text>            click the first visible element with this accessible name/text
  click-css <selector>    click by CSS selector
  fill <label|css> <text> type into an input (by label/placeholder, or CSS)
  press <key>             keyboard key (Enter, Tab, Escape...)
  viewport <w> <h>        resize (e.g. 390 844 mobile, 1280 800 desktop)
  screenshot <name>       full-page PNG into out/shots/<name>.png
  scroll <px>             scroll by px (negative = up)
  back | reload | url     history back / reload / print current URL
  wait <ms>               sleep (max 10000)
  console | network       console/page errors and failed requests recorded so far`;

function sameOrigin(raw) {
  const u = new URL(raw, origin);
  if (u.origin !== origin) fail(`navigation outside ${origin} is not allowed`);
  return u.href;
}

function events(kinds) {
  if (!QA_EVENTS || !existsSync(QA_EVENTS)) return [];
  return readFileSync(QA_EVENTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => kinds.includes(e.kind));
}

if (!cmd || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}
if (cmd === "console" || cmd === "network") {
  const list = events(
    cmd === "console" ? ["console", "pageerror"] : ["requestfailed", "http", "blocked"],
  );
  console.log(list.length ? list.map((e) => `${e.kind}: ${e.text}`).join("\n") : "(none)");
  process.exit(0);
}

const browser = await chromium.connectOverCDP(QA_CDP);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());

if (cmd === "record") {
  const log = (kind, text) =>
    appendFileSync(
      QA_EVENTS,
      `${JSON.stringify({ kind, text: String(text).slice(0, 400), at: Date.now() })}\n`,
    );
  const watch = (p) => {
    p.on(
      "console",
      (m) =>
        (m.type() === "error" || m.type() === "warning") &&
        log("console", `${m.type()} ${m.text()}`),
    );
    p.on("pageerror", (e) => log("pageerror", e.message));
    p.on("requestfailed", (r) =>
      log("requestfailed", `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`),
    );
    p.on(
      "response",
      (r) => r.status() >= 400 && log("http", `${r.status()} ${r.request().method()} ${r.url()}`),
    );
  };
  for (const p of context.pages()) watch(p);
  context.on("page", watch);
  // The boundary lives here, for the whole run: top-level navigation leaves the target origin
  // never (redirects, clicks, scripts included), and nothing but the target may reach this host's
  // own or private-network services.
  const target = new URL(origin);
  const local = (h) =>
    /^(localhost|\[::1\]|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.0\.0\.0)/.test(
      h,
    );
  await context.route("**/*", (route) => {
    const req = route.request();
    let u;
    try {
      u = new URL(req.url());
    } catch {
      return route.continue();
    }
    if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    const sameTarget = u.origin === target.origin;
    const topNav = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    // QA traffic never reaches ad/analytics backends (it would pollute real conversion data).
    const tracker =
      /(^|\.)(facebook\.(com|net)|doubleclick\.net|googleadservices\.com|google-analytics\.com|googletagmanager\.com|googlesyndication\.com|analytics\.google\.com|tiktok\.com|tiktokw\.us|posthog\.com|segment\.(io|com)|mixpanel\.com|amplitude\.com|branch\.io|appsflyer\.com)$/.test(
        u.hostname,
      );
    if ((topNav && !sameTarget) || (!sameTarget && (local(u.hostname) || tracker))) {
      log("blocked", `${req.method()} ${u.origin}${u.pathname}`.slice(0, 200));
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  log("ready", "recorder");
  await new Promise(() => {});
}

const name = (n) => {
  const s = String(n ?? "").replace(/\.png$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(s)) fail("invalid screenshot name");
  return s;
};

try {
  switch (cmd) {
    case "open":
      await page.goto(sameOrigin(args[0] ?? "/"), { waitUntil: "load", timeout: 45_000 });
      console.log(`${page.url()} — ${await page.title()}`);
      break;
    case "snapshot":
      console.log((await page.locator("body").ariaSnapshot({ timeout: 15_000 })).slice(0, 20_000));
      break;
    case "click": {
      const t = args.join(" ");
      const byRole = page.getByRole("button", { name: t }).or(page.getByRole("link", { name: t }));
      const target = (await byRole.count()) ? byRole.first() : page.getByText(t).first();
      await target.click({ timeout: 15_000 });
      console.log(`clicked "${t}" → ${page.url()}`);
      break;
    }
    case "click-css":
      await page.locator(args.join(" ")).first().click({ timeout: 15_000 });
      console.log(`clicked ${args.join(" ")}`);
      break;
    case "fill": {
      const [field, ...rest] = args;
      const byLabel = page.getByLabel(field).or(page.getByPlaceholder(field));
      const target = (await byLabel.count()) ? byLabel.first() : page.locator(field).first();
      await target.fill(rest.join(" "), { timeout: 15_000 });
      console.log(`filled ${field}`);
      break;
    }
    case "press":
      await page.keyboard.press(args[0] ?? "Enter");
      break;
    case "viewport": {
      const w = Number(args[0]);
      const h = Number(args[1]);
      if (!(w >= 240 && w <= 3840 && h >= 240 && h <= 3840)) fail("viewport out of range");
      // Window bounds, not emulation: emulation ends when this short-lived CDP client detaches.
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: w, height: h } });
      await page.waitForTimeout(300);
      const inner = await page.evaluate(() => [
        innerWidth,
        innerHeight,
        document.documentElement.scrollWidth,
      ]);
      console.log(
        `window ${w}x${h}; page viewport ${inner[0]}x${inner[1]}, document scrollWidth ${inner[2]}`,
      );
      break;
    }
    case "screenshot": {
      const n = name(args[0]);
      await page.screenshot({
        path: join(QA_OUT, "shots", `${n}.png`),
        fullPage: true,
        timeout: 30_000,
      });
      console.log(`saved out/shots/${n}.png`);
      break;
    }
    case "scroll":
      await page.mouse.wheel(0, Number(args[0]) || 600);
      break;
    case "back":
      await page.goBack({ timeout: 30_000 });
      if (new URL(page.url()).origin !== origin) await page.goto(origin);
      console.log(page.url());
      break;
    case "reload":
      await page.reload({ timeout: 45_000 });
      break;
    case "url":
      console.log(page.url());
      break;
    case "wait":
      await page.waitForTimeout(Math.min(10_000, Number(args[0]) || 1_000));
      break;
    default:
      fail(HELP);
  }
} catch (error) {
  fail(
    String(error?.message ?? error)
      .split("\n")[0]
      .slice(0, 400),
    1,
  );
}
// Exit without browser.close(): the lane owns the browser; dropping the connection leaves it up.
process.exit(0);
