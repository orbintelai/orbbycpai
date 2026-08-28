/**
 * extractDom.ts — Node.js orchestrator
 *
 * Responsibility: browser lifecycle only.
 *   - Launch Puppeteer
 *   - Navigate to URL
 *   - Scroll to trigger lazy-loaded content
 *   - Take screenshots
 *   - Inject extractDom.browser.js via page.evaluateOnNewDocument (CSP-safe)
 *   - Call window.__orbExtract() to run the browser-side extraction
 *   - Close browser
 *   - Download brand asset images (≥100px, not nav/header) to workDir
 *   - Return raw DOM data + screenshot paths + local asset paths
 *
 * All browser-side extraction logic lives in extractDom.browser.js (plain JavaScript).
 * Classification of colors and fonts lives in classifyVisual.ts.
 *
 * WHY evaluateOnNewDocument instead of addScriptTag:
 *   addScriptTag({content}) is blocked by strict CSPs (e.g. Stripe) that use
 *   sha256-whitelisted script-src without unsafe-inline. The browser rejects the
 *   injected script before it runs, so window.__orbExtract is never defined.
 *
 *   page.evaluateOnNewDocument() runs JavaScript in the page context BEFORE any
 *   HTML/CSS/CSP is parsed — it is not subject to Content-Security-Policy at all.
 *   This is the correct Puppeteer pattern for injecting code on CSP-strict sites.
 */

import puppeteer from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { withAnthropicRetry } from "@/lib/utils/anthropicRetry";
import type { EmitFn } from "./types";

// Path to the plain-JS browser script (relative to this file at runtime)
const BROWSER_SCRIPT_PATH = path.join(__dirname, "extractDom.browser.js");

// Read the browser script content once at module load time.
// We inject via addScriptTag({content}) rather than {path} so it works even
// on pages with a strict Content-Security-Policy that blocks external scripts.
function readBrowserScript(): string {
  const candidates = [
    BROWSER_SCRIPT_PATH,
    path.join(process.cwd(), "src/lib/pipeline/extractDom.browser.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  throw new Error(`[extractDom] Browser script not found. Tried: ${candidates.join(", ")}`);
}
const BROWSER_SCRIPT_CONTENT = readBrowserScript();

function getChromiumPath(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const p = execSync(`which ${bin}`, { encoding: "utf8" }).trim();
      if (p) {
        console.log(`[Puppeteer] Found browser at: ${p}`);
        return p;
      }
    } catch {}
  }
  console.log("[Puppeteer] Using bundled Chrome");
  return undefined;
}

// ─── Image downloader ─────────────────────────────────────────────────────────

function downloadImage(url: string, destPath: string): Promise<void> {
  return new Promise((resolve) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": new URL(url).origin,
      },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirect = res.headers.location;
        if (redirect) {
          downloadImage(redirect, destPath).then(resolve).catch(() => resolve());
        } else {
          resolve();
        }
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        resolve();
        return;
      }
      const contentType = res.headers["content-type"] || "";
      if (!contentType.startsWith("image/")) {
        resolve();
        return;
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on("finish", () => resolve());
      stream.on("error", () => resolve());
    });
    req.on("error", () => resolve());
    req.on("timeout", () => { req.destroy(); resolve(); });
  });
}

function sanitizeFilename(url: string, index: number): string {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase() || ".jpg";
    const safe = u.pathname.replace(/[^a-zA-Z0-9]/g, "_").slice(-30);
    return `asset_${index}_${safe}${ext}`;
  } catch {
    return `asset_${index}.jpg`;
  }
}

// ─── Render-readiness helpers ──────────────────────────────────────────────────

async function waitForPostNavigationStability(page: any, timeoutMs = 3000): Promise<void> {
  await page.evaluate(async (maximumWait: number) => {
    const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const fonts = (document as any).fonts?.ready ? Promise.resolve((document as any).fonts.ready).catch(() => undefined) : Promise.resolve();
    const quietDom = new Promise<void>((resolve) => {
      let quietTimer: number | undefined;
      const observer = new MutationObserver(() => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = window.setTimeout(done, 250);
      });
      const done = () => { if (quietTimer) clearTimeout(quietTimer); observer.disconnect(); resolve(); };
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      quietTimer = window.setTimeout(done, 250);
    });
    await Promise.race([Promise.all([fonts, quietDom, nextPaint()]), new Promise<void>((resolve) => setTimeout(resolve, maximumWait))]);
  }, timeoutMs).catch(() => {});
}

async function waitForPaint(page: any, timeoutMs = 500): Promise<void> {
  await page.evaluate(async (maximumWait: number) => {
    const painted = new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.race([painted, new Promise<void>((resolve) => setTimeout(resolve, maximumWait))]);
  }, timeoutMs).catch(() => {});
}

async function waitForLazyContent(page: any, timeoutMs = 1500): Promise<void> {
  await page.evaluate(async (maximumWait: number) => {
    const ready = new Promise<void>((resolve) => {
      const started = performance.now();
      let previousHeight = document.documentElement.scrollHeight;
      let stablePasses = 0;
      const check = () => {
        const imagesReady = Array.from(document.images).every((image) => image.complete);
        const height = document.documentElement.scrollHeight;
        stablePasses = height === previousHeight ? stablePasses + 1 : 0;
        previousHeight = height;
        if ((imagesReady && stablePasses >= 2) || performance.now() - started >= maximumWait) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
    await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, maximumWait))]);
  }, timeoutMs).catch(() => {});
}

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractDom(
  url: string,
  workDir: string,
  emit?: EmitFn,
  externalScreenshotPath?: string
): Promise<Record<string, unknown>> {
  // When externalScreenshotPath is provided (hybrid mode), skip Puppeteer screenshot.
  // The screenshot was taken by the agent's real browser and is already verified.
  const useExternalScreenshot = !!externalScreenshotPath && fs.existsSync(externalScreenshotPath);

  // Browser script content is pre-loaded at module init (BROWSER_SCRIPT_CONTENT)

  emit?.({ type: "status", step: 1, total: 6, message: `Connecting to ${new URL(url).hostname}...` });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: getChromiumPath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // NOTE: --disable-gpu intentionally omitted.
      // It causes blank screenshots on sites using GPU-rendered gradients
      // (WebGL, CSS backdrop-filter). Railway containers handle headless
      // Chrome without it using --no-sandbox + --disable-dev-shm-usage.
      "--ignore-certificate-errors",
    ],
  });

  let raw: Record<string, unknown> = {};

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Register the extraction function BEFORE navigation so it runs before CSP is applied.
    // evaluateOnNewDocument is not subject to Content-Security-Policy — it runs in the
    // page context before any HTML/CSS is parsed, making it safe on Stripe, HubSpot, etc.
    await page.evaluateOnNewDocument(BROWSER_SCRIPT_CONTENT);

    // ── Pop-up / modal suppression ─────────────────────────────────────────────
    // 90%+ of DTC sites fire a pop-up on first visit. Puppeteer looks like a new
    // visitor every time, so it always gets the pop-up. We suppress it two ways:
    //   1. Pre-set localStorage/cookie flags that pop-up scripts check before firing
    //   2. After load, forcibly remove any visible overlay/modal/pop-up elements
    // This must run BEFORE navigation so the flags are present when the page loads.
    await page.evaluateOnNewDocument(() => {
      // Common localStorage keys used by pop-up scripts to track "already seen"
      const suppressKeys = [
        "hasSeenPopup", "popupSeen", "popup_seen", "modal_seen", "hasSeenModal",
        "newsletter_popup", "email_popup", "klaviyo_popup", "privy_seen",
        "justuno_seen", "wheelio_seen", "spin_seen", "discount_popup",
        "welcome_popup", "exit_popup", "coupon_popup",
      ];
      suppressKeys.forEach(k => {
        try { localStorage.setItem(k, "true"); } catch (_) {}
      });
      // Common sessionStorage keys
      suppressKeys.forEach(k => {
        try { sessionStorage.setItem(k, "true"); } catch (_) {}
      });
      // Klaviyo-specific: mark as subscribed
      try { localStorage.setItem("__klOnsite", JSON.stringify({ shown: true, dismissed: true })); } catch (_) {}
      // Privy-specific
      try { localStorage.setItem("privy_dismissed", "true"); } catch (_) {}
      try { localStorage.setItem("privy_shown", "true"); } catch (_) {}
    });

    // ── FIX 1: Wait for networkidle2 instead of domcontentloaded ───────────────
    // domcontentloaded fires before CSS-in-JS frameworks (Next.js/Tailwind) have
    // injected their styles. networkidle2 waits until network activity settles,
    // giving JS time to apply computed styles before we extract them.
    let navigationResponse: Awaited<ReturnType<typeof page.goto>> | null = null;
    try {
      navigationResponse = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    } catch (e) {
      // networkidle2 can time out on sites with persistent background requests
      // (analytics pings, websockets). Fall back to domcontentloaded result.
      console.warn("[extractDom] networkidle2 timeout (continuing with current state):", (e as Error).message);
    }

    // Wait for fonts, two paints, and a short DOM-quiet window; retain 3s only as
    // the cap for slow hydration rather than waiting three seconds unconditionally.
    await waitForPostNavigationStability(page, 3000);
    await page.evaluate(() => {
      const selectors = [
        // Generic overlay/modal patterns
        "[class*='popup']", "[class*='modal']", "[class*='overlay']",
        "[class*='Popup']", "[class*='Modal']", "[class*='Overlay']",
        "[id*='popup']", "[id*='modal']", "[id*='overlay']",
        "[id*='Popup']", "[id*='Modal']", "[id*='Overlay']",
        // Common pop-up platforms
        "[class*='klaviyo']", "[class*='privy']", "[class*='justuno']",
        "[class*='wheelio']", "[class*='spin-to-win']",
        "[data-testid*='popup']", "[data-testid*='modal']",
        // ── Consent / cookie-banner vendors ──────────────────────────────────
        // Each vendor uses its own prefix — generic [class*='cookie'] misses them.
        // CookieYes: cky-
        "[class*='cky']", "[id*='cky']",
        // OneTrust: onetrust-
        "[class*='onetrust']", "[id*='onetrust']",
        // Osano: osano-
        "[class*='osano']", "[id*='osano']",
        // Cookiebot / Cybot: CybotCookiebanner
        "[class*='CybotCookie']", "[id*='CybotCookie']",
        // TrustArc / TRUSTe
        "[class*='trustarc']", "[id*='trustarc']", "[class*='truste']", "[id*='truste']",
        // Termly
        "[class*='termly']", "[id*='termly']",
        // Complianz
        "[class*='cmplz']", "[id*='cmplz']",
        // Usercentrics
        "[class*='usercentrics']", "[id*='usercentrics']",
        // Generic cookie/consent/gdpr/ccpa class and id patterns
        "[class*='cookie-banner']", "[class*='cookie-bar']", "[class*='cookie-notice']",
        "[class*='consent-banner']", "[class*='consent-bar']", "[class*='gdpr-banner']",
        "[id*='cookie-banner']", "[id*='cookie-bar']", "[id*='cookie-notice']",
        "[id*='consent-banner']", "[id*='gdpr']", "[id*='ccpa']",
        // Fixed/absolute positioned elements covering viewport
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = window.getComputedStyle(el as HTMLElement);
          // Only remove if it's actually covering significant viewport area
          const isOverlay = (rect.width > 300 && rect.height > 200) ||
            style.position === "fixed" || style.position === "absolute";
          if (isOverlay) {
            (el as HTMLElement).style.display = "none";
          }
        });
      });
      // Also remove body overflow:hidden that pop-ups add to lock scroll
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "auto";
    }).catch(() => {}); // Non-fatal — continue even if this fails

    // Overlay display mutations need a paint, not an unconditional half-second pause.
    await waitForPaint(page, 500);

    emit?.({ type: "status", step: 2, total: 6, message: "Scanning colors and fonts..." });

    // Scroll to trigger lazy-loaded content
    // Wrapped in catch — some pages redirect mid-scroll causing a detached frame error
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 120);
      });
    }).catch((e: Error) => {
      // Detached frame / navigation during scroll — non-fatal, continue with current state
      console.warn("[extractDom] Scroll interrupted (non-fatal):", e.message);
    });

    // Wait for lazy assets and layout stability; retain 1.5s as a safety cap.
    await waitForLazyContent(page, 1500);

    // Full-page screenshot for Claude Vision classification step
    // In hybrid mode, use the externally-provided screenshot instead of taking one with Puppeteer.
    // This gives us a verified, fully-rendered screenshot from the agent's real browser.
    const screenshotPath = useExternalScreenshot
      ? externalScreenshotPath!
      : path.join(workDir, "screenshot.png");
    const viewportScreenshotPath = useExternalScreenshot
      ? externalScreenshotPath!
      : path.join(workDir, "screenshot_viewport.jpg");
    if (!useExternalScreenshot) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await page.screenshot({
        path: viewportScreenshotPath,
        fullPage: false,
        type: "jpeg",
        quality: 80,
      }).catch(() => {});
    } else {
      console.log(`[extractDom] Using external screenshot: ${externalScreenshotPath}`);
    };

    // ── FIX 3: Claude Vision render verification ──────────────────────────────
    // Skip verification in hybrid mode — the external screenshot is already verified
    // (it was taken by the agent's real browser and visually confirmed).
    if (!useExternalScreenshot && fs.existsSync(viewportScreenshotPath)) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const imgBuf = fs.readFileSync(viewportScreenshotPath);
        const imgBase64 = imgBuf.toString("base64");
        const verifyResponse = await withAnthropicRetry(
          () => anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 64,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgBase64 } },
                { type: "text", text: `Does this screenshot show a fully rendered brand homepage with visible colors, text, and design elements? Or does it show a blank page, loading spinner, error, or mostly white/unstyled content? Reply with exactly one word: RENDERED or BLANK.` },
              ],
            }],
          }),
          "extractDom:renderVerify"
        );
        const verdict = (verifyResponse.content[0] as { text: string }).text.trim().toUpperCase();
        console.log(`[extractDom] Render verification: ${verdict}`);
        if (verdict === "BLANK") {
          console.log("[extractDom] Page appears unrendered — waiting 4s and retaking screenshot...");
          await new Promise((r) => setTimeout(r, 4000));
          await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
          await page.screenshot({
            path: viewportScreenshotPath,
            fullPage: false,
            type: "jpeg",
            quality: 80,
          }).catch(() => {});
          console.log("[extractDom] Retook screenshot after extended wait");
        }
      } catch (e) {
        // Verification is non-fatal — if it fails, proceed with what we have
        console.warn("[extractDom] Render verification failed (non-fatal):", (e as Error).message);
      }
    }

    emit?.({ type: "status", step: 3, total: 6, message: "Reading page copy and product signals..." });

    console.log("[extractDom] Running extraction (function registered via evaluateOnNewDocument)...");

    // Call the extraction function — wrapped to handle detached frame if page navigated
    try {
      raw = await page.evaluate(() => {
        return (window as unknown as { __orbExtract: () => Record<string, unknown> }).__orbExtract();
      }) as Record<string, unknown>;
    } catch (evalErr: unknown) {
      const msg = (evalErr instanceof Error) ? evalErr.message : String(evalErr);
      if (msg.includes("detached Frame") || msg.includes("Execution context was destroyed") || msg.includes("Target closed")) {
        // Page navigated mid-extraction — wait for new frame to settle and retry once
        console.warn("[extractDom] Detached frame during extraction — waiting 3s and retrying...");
        await new Promise((r) => setTimeout(r, 3000));
        raw = await page.evaluate(() => {
          return (window as unknown as { __orbExtract: () => Record<string, unknown> }).__orbExtract();
        }) as Record<string, unknown>;
      } else {
        throw evalErr;
      }
    }

    console.log("[extractDom] Extraction complete");

    const redirectChain = navigationResponse?.request().redirectChain().map((request: { url(): string }) => request.url()) || [];
    const finalPageUrl = page.url();
    if (redirectChain.length === 0 || redirectChain[redirectChain.length - 1] !== finalPageUrl) redirectChain.push(finalPageUrl);
    raw = { ...raw, resolvedUrl: finalPageUrl, redirectChain };

    const rawPath = path.join(workDir, "raw_dom_data.json");
    fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));

    raw = {
      ...raw,
      screenshotPath,
      viewportScreenshotPath,
    };

  } finally {
    console.log("[extractDom] Closing browser...");
    await browser.close();
    console.log("[extractDom] Browser closed");
  }

  // ─── Download brand asset images ──────────────────────────────────────
  emit?.({ type: "status", step: 4, total: 6, message: "Collecting brand images..." });

  const brandAssetImages = (raw.brandAssetImages as Array<{
    src: string;
    alt: string;
    width: number;
    height: number;
    ext: string;
    isGif: boolean;
    inHero: boolean;
    positionY: number;
  }>) ?? [];

  const assetsDir = path.join(workDir, "brand_assets");
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const downloadedAssets: Array<{
    src: string;
    localPath: string;
    localUrl: string;
    alt: string;
    width: number;
    height: number;
    ext: string;
    isGif: boolean;
    inHero: boolean;
  }> = [];

  // Download up to 30 brand assets (hero first, then by position)
  const toDownload = brandAssetImages.slice(0, 30);
  for (let i = 0; i < toDownload.length; i++) {
    const asset = toDownload[i];
    if (!asset.src || asset.src.startsWith("data:")) continue;
    const filename = sanitizeFilename(asset.src, i);
    const destPath = path.join(assetsDir, filename);
    try {
      await downloadImage(asset.src, destPath);
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
        // Derive a server-relative URL from the workDir path
        // workDir is like /app/public/generations/{id} or similar
        // We'll store the relative path and let the caller resolve the URL
        downloadedAssets.push({
          src: asset.src,
          localPath: destPath,
          localUrl: "", // filled in by the route handler
          alt: asset.alt,
          width: asset.width,
          height: asset.height,
          ext: asset.ext,
          isGif: asset.isGif,
          inHero: asset.inHero,
        });
      }
    } catch (e) {
      console.warn("[extractDom] Failed to download asset:", asset.src, (e as Error).message);
    }
  }

  emit?.({ type: "status", step: 5, total: 6, message: "Identifying tech stack..." });

  console.log(`[extractDom] Downloaded ${downloadedAssets.length} brand assets`);

  emit?.({ type: "status", step: 6, total: 6, message: "Classifying brand with AI..." });

  return {
    ...raw,
    downloadedAssets,
  };
}
