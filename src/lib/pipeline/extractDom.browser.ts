/**
 * extractDom.browser.ts — Browser-side extraction logic
 *
 * This module exports a single function: browserExtract.
 * It is designed to be passed directly to Puppeteer's page.evaluate().
 *
 * CRITICAL CONSTRAINTS:
 *   - No imports (this runs in the browser context, not Node.js)
 *   - No TypeScript generics inside the function body (causes tsx/__name injection)
 *   - No Node.js APIs (window, document only)
 *   - Must return a plain JSON-serializable object
 *
 * All type annotations are on the outer function signature only.
 * Internal variables use plain JS patterns (no Map<K,V>, no Array<T>, etc.)
 */

export function browserExtract(): Record<string, unknown> {

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  const toHex = (color: string) => {
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return null;
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return "#" + [m[1], m[2], m[3]].map((v) => parseInt(v).toString(16).padStart(2, "0")).join("");
  };

  const colorsSimilar = (a: string, b: string) => {
    const pa = a.replace("#", "");
    const pb = b.replace("#", "");
    if (pa.length !== 6 || pb.length !== 6) return false;
    return (
      Math.abs(parseInt(pa.slice(0, 2), 16) - parseInt(pb.slice(0, 2), 16)) <= 12 &&
      Math.abs(parseInt(pa.slice(2, 4), 16) - parseInt(pb.slice(2, 4), 16)) <= 12 &&
      Math.abs(parseInt(pa.slice(4, 6), 16) - parseInt(pb.slice(4, 6), 16)) <= 12
    );
  };

  // colorMap: plain object used as map — { [hex]: { score, sources, totalArea } }
  const colorMap: { [key: string]: { score: number; sources: string[]; totalArea: number } } = {};

  const addColorSignal = (hex: string | null, source: string, weight: number, area = 0) => {
    if (!hex) return;
    for (const key of Object.keys(colorMap)) {
      if (colorsSimilar(key, hex)) {
        colorMap[key].score += weight;
        colorMap[key].sources.push(source);
        colorMap[key].totalArea += area;
        return;
      }
    }
    colorMap[hex] = { score: weight, sources: [source], totalArea: area };
  };

  // ── Third-party widget filter ────────────────────────────────────────────
  // These selectors match known third-party widgets injected into brand pages.
  // Their colors must NEVER contaminate the brand's color palette.
  const THIRD_PARTY_SELECTORS = [
    // Accessibility widgets
    "[id*='accessiBe']", "[class*='accessiBe']", "[id*='accessiway']", "[class*='accessiway']",
    "[id*='userway']", "[class*='userway']", "[id*='audioeye']", "[class*='audioeye']",
    "[id*='equalweb']", "[class*='equalweb']",
    // Chat widgets
    "[id*='intercom']", "[class*='intercom']", "[id*='drift']", "[class*='drift']",
    "[id*='hubspot']", "[class*='hubspot']", "[id*='zendesk']", "[class*='zendesk']",
    "[id*='freshchat']", "[class*='freshchat']", "[id*='crisp']", "[class*='crisp']",
    // Cookie banners
    "[id*='cookiebot']", "[class*='cookiebot']", "[id*='onetrust']", "[class*='onetrust']",
    "[id*='cookie-consent']", "[class*='cookie-banner']",
    // Shopify app widgets
    "[id*='shopify-section-apps']", "[class*='shopify-app']",
    // Generic third-party iframes
    "iframe",
  ];

  const isThirdPartyElement = (el: Element): boolean => {
    for (const sel of THIRD_PARTY_SELECTORS) {
      try {
        if (el.closest(sel)) return true;
      } catch (_) { /* invalid selector — skip */ }
    }
    return false;
  };

  const getBgColor = (el: Element) => {
    if (isThirdPartyElement(el)) return null;
    const cs = window.getComputedStyle(el);
    const bg = cs.backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return toHex(bg);
    const bgImg = cs.backgroundImage;
    if (bgImg && bgImg !== "none") {
      const m = bgImg.match(/rgba?\([\d,\s.]+\)|#[0-9a-fA-F]{3,6}/);
      if (m) return toHex(m[0]) ?? null;
    }
    return null;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // COLOR DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  const pageHeight = document.documentElement.scrollHeight;
  const pageWidth = document.documentElement.scrollWidth;

  // ── 1. Area-weighted background scan ─────────────────────────────────
  const blockEls = Array.from(document.querySelectorAll(
    "body, header, nav, main, section, div, article, aside, footer, [class*='hero'], [class*='section'], [class*='banner'], [class*='wrapper'], [class*='container']"
  ));
  for (const el of blockEls) {
    const rect = el.getBoundingClientRect();
    const absTop = rect.top + window.scrollY;
    const w = rect.width;
    const h = rect.height;
    if (w < 200 || h < 50) continue;
    if (absTop > pageHeight) continue;
    const area = w * h;
    const bg = getBgColor(el);
    if (bg) {
      const areaScore = Math.min(Math.round(area / (pageWidth * 300)), 5);
      const tag = el.tagName.toLowerCase();
      const cls = (el.className ?? "").toString().slice(0, 40);
      addColorSignal(bg, `area:${tag}.${cls}`, Math.max(areaScore, 1), area);
    }
  }

  // ── 2. Meta theme-color ───────────────────────────────────────────────
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  const themeColor = themeColorMeta ? themeColorMeta.getAttribute("content") : null;
  addColorSignal(toHex(themeColor ?? ""), "meta:theme-color", 5);

  const msTileMeta = document.querySelector('meta[name="msapplication-TileColor"]');
  const msTile = msTileMeta ? msTileMeta.getAttribute("content") : null;
  addColorSignal(toHex(msTile ?? ""), "meta:ms-tile", 3);

  // ── 3. CSS variables ──────────────────────────────────────────────────
  const colorVarPattern = /color|primary|brand|accent|highlight|cta|button|link|main/i;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules ?? [])) {
        if (rule instanceof CSSStyleRule) {
          const sel = rule.selectorText ?? "";
          if (sel === ":root" || sel === "html" || sel.includes("[data-theme") || sel.includes("[data-color")) {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith("--")) {
                const val = rule.style.getPropertyValue(prop).trim();
                if (val.startsWith("#") || val.startsWith("rgb")) {
                  const weight = colorVarPattern.test(prop) ? 4 : 1;
                  addColorSignal(toHex(val), `cssvar:${prop}`, weight);
                }
              }
            }
          }
        }
      }
    } catch (_) { /* cross-origin stylesheet — skip */ }
  }

  // ── 4. CTA buttons ────────────────────────────────────────────────────
  const allButtons = Array.from(document.querySelectorAll(
    "button, a, [role='button'], input[type='submit'], input[type='button']"
  ));
  for (const el of allButtons) {
    if (isThirdPartyElement(el)) continue;
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 50) continue;
    const rect = el.getBoundingClientRect();
    const absTop = rect.top + window.scrollY;
    if (absTop > pageHeight * 0.75) continue;
    if (el.closest("nav, header nav") || el.closest("footer")) continue;
    const bg = getBgColor(el);
    if (bg) {
      addColorSignal(bg, "cta:background", 3);
      const textHex = toHex(window.getComputedStyle(el).color);
      if (textHex) addColorSignal(textHex, "cta:text", 1);
    }
  }

  // ── 5. Nav/header background ──────────────────────────────────────────
  const navEl = document.querySelector("header, nav, [role='navigation']");
  if (navEl) {
    const bg = getBgColor(navEl);
    if (bg) addColorSignal(bg, "nav:background", 3);
    const textHex = toHex(window.getComputedStyle(navEl).color);
    if (textHex) addColorSignal(textHex, "nav:text", 1);
  }

  // ── 6. H1 text color ──────────────────────────────────────────────────
  for (const el of Array.from(document.querySelectorAll("h1"))) {
    if (el.closest("nav, footer, aside")) continue;
    const absTop = el.getBoundingClientRect().top + window.scrollY;
    if (absTop > pageHeight * 0.65) continue;
    const textHex = toHex(window.getComputedStyle(el).color);
    if (textHex) addColorSignal(textHex, "h1:color", 2);
    break;
  }

  // ── 7. H2 text color ──────────────────────────────────────────────────
  const h2 = document.querySelector("h2");
  if (h2 && !h2.closest("nav, footer")) {
    const textHex = toHex(window.getComputedStyle(h2).color);
    if (textHex) addColorSignal(textHex, "h2:color", 1);
  }

  // ── 8. Footer background ──────────────────────────────────────────────
  const footer = document.querySelector("footer");
  if (footer) {
    const bg = getBgColor(footer);
    if (bg) addColorSignal(bg, "footer:background", 2);
  }

  // ── 9. Accent/badge elements ──────────────────────────────────────────
  for (const sel of [
    "[class*='badge']", "[class*='tag']", "[class*='chip']", "[class*='pill']",
    "[class*='label']", "[class*='highlight']", "[class*='accent']", "mark",
  ]) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const bg = getBgColor(el);
    if (bg) addColorSignal(bg, `accent:${sel}`, 2);
    const textHex = toHex(window.getComputedStyle(el).color);
    if (textHex) addColorSignal(textHex, `accent-text:${sel}`, 1);
  }

  // ── 10. Link color ────────────────────────────────────────────────────
  const firstLink = document.querySelector("main a, article a, section a");
  if (firstLink) {
    const textHex = toHex(window.getComputedStyle(firstLink).color);
    if (textHex) addColorSignal(textHex, "link:color", 1);
  }

  // Build scored palette — sorted by score desc, then area desc
  const scoredPalette = Object.entries(colorMap)
    .sort((a, b) => {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      return b[1].totalArea - a[1].totalArea;
    })
    .slice(0, 12)
    .map(([hex, { score, sources, totalArea }]) => ({ hex, score, sources, totalArea }));

  // Page background color (body)
  const bodyBg = getBgColor(document.body) ??
    toHex(window.getComputedStyle(document.documentElement).backgroundColor);

  // ═══════════════════════════════════════════════════════════════════════
  // FONT DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  // Normalise a fontFamily string to just the first named family and repair
  // compact CSS tokens so evidence-facing labels remain human-readable.
  const cleanFamily = (raw: string) => {
    const family = raw.split(",")[0].trim().replace(/['"]/g, "");
    const compact = family.replace(/[\s_-]/g, "").toLowerCase();
    if (compact === "dmsans") return "DM Sans";
    return family;
  };

  // Returns null for pure system/generic fallbacks
  const brandFamily = (raw: string) => {
    const clean = cleanFamily(raw);
    if (!clean) return null;
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|BlinkMacSystemFont|Segoe\s*UI|Arial|Helvetica|Times\s*New\s*Roman|Times|Georgia|Courier\s*New|Courier|Verdana|Tahoma|Trebuchet)$/i.test(clean)) return null;
    return clean;
  };

  // Per-element map: elementLabel → font family (null if only system fonts)
  const fontElementMap: { [key: string]: string | null } = {};

  // Scored map for ranking — plain object, no Map<K,V>
  const fontScoreMap: { [key: string]: { score: number; seenOn: string[] } } = {};

  const addFontScore = (family: string, label: string, weight: number) => {
    if (fontScoreMap[family]) {
      fontScoreMap[family].score += weight;
      if (!fontScoreMap[family].seenOn.includes(label)) fontScoreMap[family].seenOn.push(label);
    } else {
      fontScoreMap[family] = { score: weight, seenOn: [label] };
    }
  };

  // Helper: find first element matching selector that is NOT inside a third-party widget
  const queryBrandEl = (sel: string): Element | null => {
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els) {
      if (!isThirdPartyElement(el)) return el;
    }
    return null;
  };

  // HIGH-signal content elements (weight 3)
  const highTargets = [
    { sel: "h1", label: "h1" },
    { sel: "h2", label: "h2" },
    { sel: "h3", label: "h3" },
    { sel: "h4", label: "h4" },
    { sel: "p",  label: "p" },
    { sel: "li", label: "li" },
    { sel: "blockquote", label: "blockquote" },
  ];
  for (const { sel, label } of highTargets) {
    try {
      const el = queryBrandEl(sel);
      if (!el) continue;
      const fam = brandFamily(window.getComputedStyle(el).fontFamily);
      fontElementMap[label] = fam;
      if (fam) addFontScore(fam, label, 3);
    } catch (_) {}
  }

  // Scan up to 10 headings to catch per-heading font variation
  for (const el of Array.from(document.querySelectorAll("h1, h2, h3, h4")).slice(0, 10)) {
    if (isThirdPartyElement(el)) continue;
    const fam = brandFamily(window.getComputedStyle(el).fontFamily);
    if (fam) addFontScore(fam, el.tagName.toLowerCase(), 2);
  }

  // MED-signal interactive elements (weight 2)
  const medTargets = [
    { sel: "nav a, header a",                              label: "nav" },
    { sel: "button, a[class*='btn'], input[type='submit']", label: "button" },
    { sel: "label, input, select",                          label: "form" },
  ];
  for (const { sel, label } of medTargets) {
    try {
      const el = queryBrandEl(sel);
      if (!el) continue;
      const fam = brandFamily(window.getComputedStyle(el).fontFamily);
      fontElementMap[label] = fam;
      if (fam) addFontScore(fam, label, 2);
    } catch (_) {}
  }

  // LOW-signal structural elements (weight 1) — recorded but used only as fallback
  const lowTargets = [
    { sel: "body",   label: "body" },
    { sel: "footer", label: "footer" },
  ];
  for (const { sel, label } of lowTargets) {
    try {
      const el = queryBrandEl(sel);
      if (!el) continue;
      const fam = brandFamily(window.getComputedStyle(el).fontFamily);
      fontElementMap[label] = fam;
      if (fam) addFontScore(fam, label, 1);
    } catch (_) {}
  }

  // Ranked list (highest score first) for Claude context
  const discoveredFonts = Object.entries(fontScoreMap)
    .sort((a, b) => b[1].score - a[1].score)
    .map(([family, { score, seenOn }]) => ({ family, seenOn, score }));

  // ═══════════════════════════════════════════════════════════════════════
  // LOGO DISCOVERY (AND-validated)
  // ═══════════════════════════════════════════════════════════════════════

  let logo: { type: string; src?: string; alt?: string; width?: number; height?: number; outerHTML?: string; confidence: string } | null = null;

  // Score img candidates: prefer those with 'logo' in src/alt/class, reject obvious non-logos
  const navImgs = Array.from(document.querySelectorAll(
    "header img, nav img, [class*='logo'] img, [id*='logo'] img, [class*='brand'] img"
  ));
  const scoredImgs: { img: HTMLImageElement; score: number }[] = [];
  for (const el of navImgs) {
    // Skip logos injected by third-party widgets (OneTrust, Intercom, etc.)
    if (isThirdPartyElement(el)) continue;
    const img = el as HTMLImageElement;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const src = img.src ?? "";
    if (!src || src.startsWith("data:")) continue;
    if (w === 0 || h === 0) continue;
    // Reject images that are clearly not logos (too large, wrong aspect ratio)
    if (w > 600 || h > 300) continue;
    // Reject near-square large images (illustrations, not logos)
    if (w > 200 && h > 200 && Math.abs(w / h - 1) < 0.4) continue;
    if (src.includes("background") || src.includes("hero") || src.includes("banner") || src.includes("group") || src.includes("illustration")) continue;
    let score = 0;
    if (src.toLowerCase().includes("logo")) score += 10;
    if ((img.alt ?? "").toLowerCase().includes("logo")) score += 10;
    if ((img.className ?? "").toLowerCase().includes("logo")) score += 5;
    // Prefer wide logos (typical brand logo aspect ratio)
    if (w > h * 1.5) score += 3;
    scoredImgs.push({ img, score });
  }
  scoredImgs.sort((a, b) => b.score - a.score);
  if (scoredImgs.length > 0) {
    const { img } = scoredImgs[0];
    logo = { type: "img", src: img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight, confidence: "high" };
  }

  if (!logo) {
    const navSvgs = Array.from(document.querySelectorAll(
      "header svg, nav svg, [class*='logo'] svg, [id*='logo'] svg, a[href='/'] svg, a[href='#'] svg"
    ));
    for (const el of navSvgs) {
      // Skip SVGs injected by third-party widgets
      if (isThirdPartyElement(el)) continue;
      const rect = el.getBoundingClientRect();
      // Allow rect.width === 0 (SVG not yet painted / inside hidden container)
      // Only skip if explicitly oversized
      if (rect.width > 400 || rect.height > 200) continue;
      const svgHtml = el.outerHTML;
      // Skip tiny decorative SVGs (icons, chevrons) — real logos have meaningful path data
      if (svgHtml.length < 50) continue;
      logo = { type: "svg", outerHTML: svgHtml.slice(0, 8000), confidence: "high" };
      break;
    }
  }

  if (!logo) {
    const topImgs = Array.from(document.querySelectorAll("img")).filter((img) => {
      // Skip images from third-party widgets
      if (isThirdPartyElement(img)) return false;
      const rect = img.getBoundingClientRect();
      const absTop = rect.top + window.scrollY;
      return absTop < pageHeight * 0.15 && img.naturalWidth > 0 && img.naturalWidth < 400 && img.naturalHeight < 200;
    });
    if (topImgs.length > 0) {
      const img = topImgs[0] as HTMLImageElement;
      logo = { type: "img", src: img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight, confidence: "medium" };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATS DISCOVERY (AND-validated)
  // ═══════════════════════════════════════════════════════════════════════

  const stats: { value: string; label: string }[] = [];
  const numericPattern = /^\$?[\d,]+(\.\d+)?[%+kKmMxX]?$|^[\d,]+(\.\d+)?(\s*(million|billion|thousand|%|\+|x))?$/i;

  const statCandidates: { value: string; label: string; parent: Element }[] = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (el.closest("nav, footer, form, script, style")) continue;
    const children = Array.from(el.children);
    if (children.length < 2) continue;
    let numericChild: Element | null = null;
    let labelChild: Element | null = null;
    for (const child of children) {
      const text = (child.textContent ?? "").trim();
      if (numericPattern.test(text) && text.length < 20) numericChild = child;
      else if (text.length > 2 && text.length < 80 && !numericPattern.test(text)) labelChild = child;
    }
    if (numericChild && labelChild) {
      statCandidates.push({
        value: (numericChild.textContent ?? "").trim(),
        label: (labelChild.textContent ?? "").trim(),
        parent: el.parentElement ?? el,
      });
    }
  }

  // AND condition: at least 2 stat pairs must share the same parent container
  const parentCounts: { [key: number]: number } = {};
  const parentIndex: Element[] = [];
  for (const c of statCandidates) {
    let idx = parentIndex.indexOf(c.parent);
    if (idx === -1) { idx = parentIndex.length; parentIndex.push(c.parent); }
    parentCounts[idx] = (parentCounts[idx] ?? 0) + 1;
  }
  for (const c of statCandidates) {
    const idx = parentIndex.indexOf(c.parent);
    if ((parentCounts[idx] ?? 0) >= 2 && !stats.find((s) => s.value === c.value)) {
      stats.push({ value: c.value, label: c.label });
    }
    if (stats.length >= 6) break;
  }
  // Single-stat fallback: if AND-validated grid scan found nothing, include
  // isolated stat+label pairs (e.g. Magic Mind's "5×" hero stat).
  if (stats.length === 0) {
    for (const c of statCandidates) {
      if (!stats.find((s) => s.value === c.value)) {
        stats.push({ value: c.value, label: c.label });
      }
      if (stats.length >= 3) break;
    }
  }

  // ═══════════════════════════════════════
  // TESTIMONIALS DISCOVERY (AND-validated)
  // ═══════════════════════════════════════════════════════════════════════

  const testimonials: { quote: string; author: string }[] = [];
  const attributionPattern = /^[A-Z][a-z]+(\s[A-Z][a-z]+)*[,\s—\-]|CEO|Founder|Director|Manager|Co-founder/;

  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (el.closest("nav, footer, form, script, style")) continue;
    const children = Array.from(el.children);
    if (children.length < 2) continue;
    let quoteChild: Element | null = null;
    let authorChild: Element | null = null;
    for (const child of children) {
      const text = (child.textContent ?? "").trim();
      if (text.length > 60 && text.length < 500 && !numericPattern.test(text.slice(0, 10))) quoteChild = child;
      else if (text.length > 3 && text.length < 80 && attributionPattern.test(text)) authorChild = child;
    }
    if (quoteChild && authorChild) {
      const quote = (quoteChild.textContent ?? "").trim().replace(/^["'"']|["'"']$/g, "");
      const author = (authorChild.textContent ?? "").trim();
      if (!testimonials.find((t) => t.quote === quote)) testimonials.push({ quote, author });
    }
    if (testimonials.length >= 4) break;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COPY TEXT, META, PHOTOGRAPHY
  // ═══════════════════════════════════════════════════════════════════════

  const copyText = {
    h1: Array.from(document.querySelectorAll("h1")).map((el) => el.textContent?.trim() ?? "").filter(Boolean).slice(0, 5),
    h2: Array.from(document.querySelectorAll("h2")).map((el) => el.textContent?.trim() ?? "").filter(Boolean).slice(0, 8),
    nav: Array.from(document.querySelectorAll("nav a")).map((el) => el.textContent?.trim() ?? "").filter(Boolean).slice(0, 10),
    cta: allButtons.filter((el) => {
      const text = (el.textContent ?? "").trim();
      return text.length > 0 && text.length <= 50;
    }).map((el) => el.textContent?.trim() ?? "").filter(Boolean).slice(0, 5),
  };

  const bodySnippet = document.body.innerText.slice(0, 3000);

  const faviconEl = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
  const favicon = faviconEl?.href ?? "";
  const ogImageMeta = document.querySelector('meta[property="og:image"]');
  const ogImage = ogImageMeta ? ogImageMeta.getAttribute("content") ?? "" : "";
  const ogTitleMeta = document.querySelector('meta[property="og:title"]');
  const ogTitle = ogTitleMeta ? ogTitleMeta.getAttribute("content") ?? document.title : document.title;
  const siteNameMeta = document.querySelector('meta[property="og:site_name"]');
  const rawSiteName = siteNameMeta ? siteNameMeta.getAttribute("content") ?? "" : "";
  const genericNames = ["my site", "home", "website", "untitled", "wix site"];
  const brandName = genericNames.includes(rawSiteName.toLowerCase()) ? "" : rawSiteName;

  const images = Array.from(document.querySelectorAll("img"))
    .filter((img) => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      // Require meaningful image dimensions — filter out thumbnails, swatches, icons
      if (w < 400 || h < 300) return false;
      if (img.closest("nav, header")) return false;
      const src = img.src ?? "";
      if (src.includes("data:") || src.includes("logo") || src.includes("icon") || src.includes("avatar")) return false;
      // Skip near-square small images (product swatches, color chips)
      if (w < 600 && h < 600 && Math.abs(w - h) < 80) return false;
      return true;
    })
    .map((img) => ({
      src: img.src,
      alt: img.alt ?? "",
      width: img.naturalWidth,
      height: img.naturalHeight,
      inHero: !!img.closest('[class*="hero"], [class*="Hero"], section:first-of-type'),
    }))
    .slice(0, 30);

  const bgImages = Array.from(document.querySelectorAll('[class*="hero"], [class*="Hero"], section, div'))
    .map((el) => {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none" && bg.includes("url(")) {
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        return match ? match[1] : null;
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 10) as string[];

  const spatialFor = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const parseVal = (v: string) => parseFloat(v) || 0;
    return {
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      avgPadding: (parseVal(cs.paddingTop) + parseVal(cs.paddingBottom) + parseVal(cs.paddingLeft) + parseVal(cs.paddingRight)) / 4,
      avgMargin: (parseVal(cs.marginTop) + parseVal(cs.marginBottom)) / 2,
    };
  };
  const spatial = spatialFor("body") ?? spatialFor("section") ?? { avgPadding: 16, avgMargin: 8 };

  // Collect border-radius from actual CTA buttons (non-transparent background).
  // Prioritize filled buttons over ghost/text buttons to capture pill shapes correctly.
  // Tailwind's rounded-full computes to 9999px at runtime, which we capture here.
  const borderRadii: string[] = [];
  const filledButtons = allButtons.filter((el) => {
    if (isThirdPartyElement(el)) return false;
    const cs = window.getComputedStyle(el as HTMLElement);
    const bg = cs.backgroundColor;
    return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
  });
  const brandButtons = allButtons.filter((el) => !isThirdPartyElement(el));
  const buttonsToSample = filledButtons.length > 0 ? filledButtons.slice(0, 5) : brandButtons.slice(0, 5);
  for (const el of buttonsToSample) {
    const r = window.getComputedStyle(el as HTMLElement).borderRadius;
    if (r && r !== "0px") borderRadii.push(r);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════════════════════════════

  return {
    url: window.location.href,
    title: document.title,
    brandName,
    ogTitle,
    ogImage,
    favicon,
    // Color discovery output — classification happens in classifyVisual.ts
    scoredPalette,
    backgroundColor: bodyBg,
    // Font discovery output — classification happens in classifyVisual.ts
    discoveredFonts,
    fontElementMap,
    // Validated elements
    logo,
    borderRadii,
    // Content
    copyText,
    bodySnippet,
    stats,
    testimonials,
    // Photography
    images,
    bgImages,
    spatial,
    // Legacy compat fields
    colorSamples: scoredPalette.map((c) => ({ hex: c.hex, contexts: c.sources, count: c.score })),
    logoImgs: logo?.type === "img" ? [{ src: logo.src, alt: logo.alt, width: logo.width, height: logo.height }] : [],
    logoSvgs: logo?.type === "svg" ? [{ type: "inline-svg", outerHTML: logo.outerHTML }] : [],
  };
}
