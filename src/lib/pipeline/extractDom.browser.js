/**
 * extractDom.browser.js — Browser-side extraction logic
 *
 * Plain JavaScript. No TypeScript. No compilation. No imports.
 * This file is read from disk and injected into the page via page.addScriptTag().
 * It assigns the extraction function to window.__orbExtract so it can be called
 * via page.evaluate(() => window.__orbExtract()).
 *
 * NEVER add TypeScript syntax to this file.
 * NEVER import from Node.js modules.
 */

window.__orbExtract = function () {

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  function toHex(color) {
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return null;
    var m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return "#" + [m[1], m[2], m[3]].map(function (v) { return parseInt(v).toString(16).padStart(2, "0"); }).join("");
  }

  function colorsSimilar(a, b) {
    var pa = a.replace("#", "");
    var pb = b.replace("#", "");
    if (pa.length !== 6 || pb.length !== 6) return false;
    return (
      Math.abs(parseInt(pa.slice(0, 2), 16) - parseInt(pb.slice(0, 2), 16)) <= 12 &&
      Math.abs(parseInt(pa.slice(2, 4), 16) - parseInt(pb.slice(2, 4), 16)) <= 12 &&
      Math.abs(parseInt(pa.slice(4, 6), 16) - parseInt(pb.slice(4, 6), 16)) <= 12
    );
  }

  // colorMap: plain object — { [hex]: { score, sources, totalArea } }
  var colorMap = {};

  function addColorSignal(hex, source, weight, area) {
    if (!hex) return;
    area = area || 0;
    var keys = Object.keys(colorMap);
    for (var i = 0; i < keys.length; i++) {
      if (colorsSimilar(keys[i], hex)) {
        colorMap[keys[i]].score += weight;
        colorMap[keys[i]].sources.push(source);
        colorMap[keys[i]].totalArea += area;
        return;
      }
    }
    colorMap[hex] = { score: weight, sources: [source], totalArea: area };
  }

  function getBgColor(el) {
    var cs = window.getComputedStyle(el);
    var bg = cs.backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return toHex(bg);
    var bgImg = cs.backgroundImage;
    if (bgImg && bgImg !== "none") {
      var m = bgImg.match(/rgba?\([\d,\s.]+\)|#[0-9a-fA-F]{3,6}/);
      if (m) return toHex(m[0]) || null;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COLOR DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  var pageHeight = document.documentElement.scrollHeight;
  var pageWidth = document.documentElement.scrollWidth;

  // ── 1. Area-weighted background scan ─────────────────────────────────
  var blockEls = Array.from(document.querySelectorAll(
    "body, header, nav, main, section, div, article, aside, footer, [class*='hero'], [class*='section'], [class*='banner'], [class*='wrapper'], [class*='container']"
  ));
  for (var i = 0; i < blockEls.length; i++) {
    var el = blockEls[i];
    var rect = el.getBoundingClientRect();
    var absTop = rect.top + window.scrollY;
    var w = rect.width;
    var h = rect.height;
    if (w < 200 || h < 50) continue;
    if (absTop > pageHeight) continue;
    var area = w * h;
    var bg = getBgColor(el);
    if (bg) {
      var areaScore = Math.min(Math.round(area / (pageWidth * 300)), 5);
      var tag = el.tagName.toLowerCase();
      var cls = (el.className || "").toString().slice(0, 40);
      addColorSignal(bg, "area:" + tag + "." + cls, Math.max(areaScore, 1), area);
    }
  }

  // ── 2. Meta theme-color ───────────────────────────────────────────────
  var themeColorMeta = document.querySelector('meta[name="theme-color"]');
  var themeColor = themeColorMeta ? themeColorMeta.getAttribute("content") : null;
  addColorSignal(toHex(themeColor || ""), "meta:theme-color", 5);

  var msTileMeta = document.querySelector('meta[name="msapplication-TileColor"]');
  var msTile = msTileMeta ? msTileMeta.getAttribute("content") : null;
  addColorSignal(toHex(msTile || ""), "meta:ms-tile", 3);

  // ── 3. CSS variables ──────────────────────────────────────────────────
  var colorVarPattern = /color|primary|brand|accent|highlight|cta|button|link|main/i;
  var sheets = Array.from(document.styleSheets);
  for (var si = 0; si < sheets.length; si++) {
    try {
      var rules = Array.from(sheets[si].cssRules || []);
      for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        if (rule instanceof CSSStyleRule) {
          var sel = rule.selectorText || "";
          if (sel === ":root" || sel === "html" || sel.indexOf("[data-theme") !== -1 || sel.indexOf("[data-color") !== -1) {
            for (var pi = 0; pi < rule.style.length; pi++) {
              var prop = rule.style[pi];
              if (prop.indexOf("--") === 0) {
                var val = rule.style.getPropertyValue(prop).trim();
                if (val.indexOf("#") === 0 || val.indexOf("rgb") === 0) {
                  var varWeight = colorVarPattern.test(prop) ? 4 : 1;
                  addColorSignal(toHex(val), "cssvar:" + prop, varWeight);
                }
              }
            }
          }
        }
      }
    } catch (e) { /* cross-origin */ }
  }

  // ── 4. CTA buttons ────────────────────────────────────────────────────
  var allButtons = Array.from(document.querySelectorAll(
    "button, a, [role='button'], input[type='submit'], input[type='button']"
  ));
  for (var bi = 0; bi < allButtons.length; bi++) {
    var btn = allButtons[bi];
    var text = (btn.textContent || "").trim();
    if (text.length === 0 || text.length > 50) continue;
    var btnRect = btn.getBoundingClientRect();
    var btnTop = btnRect.top + window.scrollY;
    if (btnTop > pageHeight * 0.75) continue;
    if (btn.closest("nav, header nav") || btn.closest("footer")) continue;
    var btnBg = getBgColor(btn);
    if (btnBg) {
      addColorSignal(btnBg, "cta:background", 3);
      var btnTextHex = toHex(window.getComputedStyle(btn).color);
      if (btnTextHex) addColorSignal(btnTextHex, "cta:text", 1);
    }
  }

  // ── 5. Nav/header background ──────────────────────────────────────────
  var navEl = document.querySelector("header, nav, [role='navigation']");
  if (navEl) {
    var navBg = getBgColor(navEl);
    if (navBg) addColorSignal(navBg, "nav:background", 3);
    var navTextHex = toHex(window.getComputedStyle(navEl).color);
    if (navTextHex) addColorSignal(navTextHex, "nav:text", 1);
  }

  // ── 6. H1 text color ──────────────────────────────────────────────────
  var h1Els = Array.from(document.querySelectorAll("h1"));
  for (var h1i = 0; h1i < h1Els.length; h1i++) {
    var h1El = h1Els[h1i];
    if (h1El.closest("nav, footer, aside")) continue;
    var h1Top = h1El.getBoundingClientRect().top + window.scrollY;
    if (h1Top > pageHeight * 0.65) continue;
    var h1Hex = toHex(window.getComputedStyle(h1El).color);
    if (h1Hex) addColorSignal(h1Hex, "h1:color", 2);
    break;
  }

  // ── 7. H2 text color ──────────────────────────────────────────────────
  var h2El = document.querySelector("h2");
  if (h2El && !h2El.closest("nav, footer")) {
    var h2Hex = toHex(window.getComputedStyle(h2El).color);
    if (h2Hex) addColorSignal(h2Hex, "h2:color", 1);
  }

  // ── 8. Footer background ──────────────────────────────────────────────
  var footerEl = document.querySelector("footer");
  if (footerEl) {
    var footerBg = getBgColor(footerEl);
    if (footerBg) addColorSignal(footerBg, "footer:background", 2);
  }

  // ── 9. Accent/badge elements ──────────────────────────────────────────
  var accentSelectors = [
    "[class*='badge']", "[class*='tag']", "[class*='chip']", "[class*='pill']",
    "[class*='label']", "[class*='highlight']", "[class*='accent']", "mark",
  ];
  for (var ai = 0; ai < accentSelectors.length; ai++) {
    var accentEl = document.querySelector(accentSelectors[ai]);
    if (!accentEl) continue;
    var accentBg = getBgColor(accentEl);
    if (accentBg) addColorSignal(accentBg, "accent:" + accentSelectors[ai], 2);
    var accentTextHex = toHex(window.getComputedStyle(accentEl).color);
    if (accentTextHex) addColorSignal(accentTextHex, "accent-text:" + accentSelectors[ai], 1);
  }

  // ── 10. Link color ────────────────────────────────────────────────────
  var firstLink = document.querySelector("main a, article a, section a");
  if (firstLink) {
    var linkHex = toHex(window.getComputedStyle(firstLink).color);
    if (linkHex) addColorSignal(linkHex, "link:color", 1);
  }

  // Build scored palette — sorted by score desc, then area desc
  var scoredPalette = Object.entries(colorMap)
    .sort(function (a, b) {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      return b[1].totalArea - a[1].totalArea;
    })
    .slice(0, 12)
    .map(function (entry) {
      return { hex: entry[0], score: entry[1].score, sources: entry[1].sources, totalArea: entry[1].totalArea };
    });

  // Page background color
  var bodyBg = getBgColor(document.body) ||
    toHex(window.getComputedStyle(document.documentElement).backgroundColor);

  // ═══════════════════════════════════════════════════════════════════════
  // FONT DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  function cleanFamily(raw) {
    return raw.split(",")[0].trim().replace(/['"]/g, "");
  }

  function brandFamily(raw) {
    var clean = cleanFamily(raw);
    if (!clean) return null;
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|BlinkMacSystemFont|Segoe\s*UI|Arial|Helvetica|Times\s*New\s*Roman|Times|Georgia|Courier\s*New|Courier|Verdana|Tahoma|Trebuchet)$/i.test(clean)) return null;
    return clean;
  }

  var fontElementMap = {};
  var fontScoreMap = {};

  function addFontScore(family, label, weight) {
    if (fontScoreMap[family]) {
      fontScoreMap[family].score += weight;
      if (fontScoreMap[family].seenOn.indexOf(label) === -1) fontScoreMap[family].seenOn.push(label);
    } else {
      fontScoreMap[family] = { score: weight, seenOn: [label] };
    }
  }

  // HIGH-signal content elements (weight 3)
  var highTargets = [
    { sel: "h1", label: "h1" },
    { sel: "h2", label: "h2" },
    { sel: "h3", label: "h3" },
    { sel: "h4", label: "h4" },
    { sel: "p",  label: "p" },
    { sel: "li", label: "li" },
    { sel: "blockquote", label: "blockquote" },
  ];
  for (var hti = 0; hti < highTargets.length; hti++) {
    try {
      var htEl = document.querySelector(highTargets[hti].sel);
      if (!htEl) continue;
      var htFam = brandFamily(window.getComputedStyle(htEl).fontFamily);
      fontElementMap[highTargets[hti].label] = htFam;
      if (htFam) addFontScore(htFam, highTargets[hti].label, 3);
    } catch (e) {}
  }

  // Scan up to 10 headings to catch per-heading font variation
  var headingEls = Array.from(document.querySelectorAll("h1, h2, h3, h4")).slice(0, 10);
  for (var hi = 0; hi < headingEls.length; hi++) {
    var hFam = brandFamily(window.getComputedStyle(headingEls[hi]).fontFamily);
    if (hFam) addFontScore(hFam, headingEls[hi].tagName.toLowerCase(), 2);
  }

  // MED-signal interactive elements (weight 2)
  var medTargets = [
    { sel: "nav a, header a",                              label: "nav" },
    { sel: "button, a[class*='btn'], input[type='submit']", label: "button" },
    { sel: "label, input, select",                          label: "form" },
  ];
  for (var mti = 0; mti < medTargets.length; mti++) {
    try {
      var mtEl = document.querySelector(medTargets[mti].sel);
      if (!mtEl) continue;
      var mtFam = brandFamily(window.getComputedStyle(mtEl).fontFamily);
      fontElementMap[medTargets[mti].label] = mtFam;
      if (mtFam) addFontScore(mtFam, medTargets[mti].label, 2);
    } catch (e) {}
  }

  // LOW-signal structural elements (weight 1) — recorded but used only as fallback
  var lowTargets = [
    { sel: "body",   label: "body" },
    { sel: "footer", label: "footer" },
  ];
  for (var lti = 0; lti < lowTargets.length; lti++) {
    try {
      var ltEl = document.querySelector(lowTargets[lti].sel);
      if (!ltEl) continue;
      var ltFam = brandFamily(window.getComputedStyle(ltEl).fontFamily);
      fontElementMap[lowTargets[lti].label] = ltFam;
      if (ltFam) addFontScore(ltFam, lowTargets[lti].label, 1);
    } catch (e) {}
  }

  // ─── Supplement with document.fonts (actually-loaded fonts) ──────────
  // document.fonts contains every FontFace the browser has loaded. These are always
  // real brand fonts (not system fallbacks), so we give them a strong score boost.
  try {
    if (document.fonts && document.fonts.forEach) {
      document.fonts.forEach(function (fontFace) {
        var fam = (fontFace.family || "").replace(/["']/g, "").trim();
        if (!fam) return;
        if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|Arial|Helvetica|Times New Roman|Times|Georgia|Courier New|Courier|Verdana|Tahoma|Trebuchet)$/i.test(fam)) return;
        addFontScore(fam, "document.fonts", 5);
      });
    }
  } catch (e) {}

  // Ranked list for Claude context
  var discoveredFonts = Object.entries(fontScoreMap)
    .sort(function (a, b) { return b[1].score - a[1].score; })
    .map(function (entry) { return { family: entry[0], seenOn: entry[1].seenOn, score: entry[1].score }; });

  // ─── Font file URLs (for brand asset collection) ──────────────────────
  var fontFileUrls = [];
  for (var fsi = 0; fsi < sheets.length; fsi++) {
    try {
      var fRules = Array.from(sheets[fsi].cssRules || []);
      for (var fri = 0; fri < fRules.length; fri++) {
        var fRule = fRules[fri];
        if (fRule.constructor && fRule.constructor.name === "CSSFontFaceRule") {
          var srcText = fRule.style && fRule.style.getPropertyValue("src");
          if (srcText) {
            var urlMatches = srcText.match(/url\(["']?([^"')]+\.(?:ttf|woff2?|otf))["']?\)/gi);
            if (urlMatches) {
              urlMatches.forEach(function (u) {
                var m = u.match(/url\(["']?([^"')]+)["']?\)/i);
                if (m && m[1]) {
                  var absUrl = m[1];
                  if (absUrl.indexOf("http") !== 0) {
                    try { absUrl = new URL(absUrl, window.location.href).href; } catch (e) {}
                  }
                  if (fontFileUrls.indexOf(absUrl) === -1) fontFileUrls.push(absUrl);
                }
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOGO DISCOVERY (AND-validated)
  // ═══════════════════════════════════════════════════════════════════════

  var logo = null;

  // Helper: returns true if an element is inside a customer/partner logo wall
  // (e.g. HubSpot's "trusted by" section which contains eBay, Airbnb logos)
  function isInLogoWall(el) {
    var ancestor = el.parentElement;
    var depth = 0;
    while (ancestor && depth < 8) {
      var cls = (ancestor.className || "").toLowerCase();
      var id = (ancestor.id || "").toLowerCase();
      var combined = cls + " " + id;
      if (
        combined.indexOf("customer") !== -1 ||
        combined.indexOf("partner") !== -1 ||
        combined.indexOf("client") !== -1 ||
        combined.indexOf("logo-wall") !== -1 ||
        combined.indexOf("logo-strip") !== -1 ||
        combined.indexOf("logo-grid") !== -1 ||
        combined.indexOf("logo-bar") !== -1 ||
        combined.indexOf("social-proof") !== -1 ||
        combined.indexOf("trusted") !== -1 ||
        combined.indexOf("brands") !== -1 ||
        combined.indexOf("marquee") !== -1
      ) return true;
      ancestor = ancestor.parentElement;
      depth++;
    }
    return false;
  }

  // Priority 1: strict nav/header — must be a direct child of nav or header
  var strictNavImgs = Array.from(document.querySelectorAll(
    "header > a img, header > div img, nav > a img, nav > div img, " +
    "[role='banner'] img, [class*='navbar'] img, [class*='nav-bar'] img, " +
    "[class*='site-header'] img, [class*='top-bar'] img"
  ));
  for (var nii = 0; nii < strictNavImgs.length; nii++) {
    var img = strictNavImgs[nii];
    if (isInLogoWall(img)) continue;
    var imgW = img.naturalWidth;
    var imgH = img.naturalHeight;
    var imgSrc = img.src || "";
    if (!imgSrc || imgSrc.indexOf("data:") === 0) continue;
    var isSvgSrc = imgSrc.split("?")[0].toLowerCase().endsWith(".svg");
    if (!isSvgSrc && (imgW === 0 || imgH === 0)) continue;
    if (imgW > 600 || imgH > 300) continue;
    if (imgSrc.indexOf("background") !== -1 || imgSrc.indexOf("hero") !== -1 || imgSrc.indexOf("banner") !== -1) continue;
    logo = { type: "img", src: imgSrc, alt: img.alt, width: imgW, height: imgH, confidence: "high" };
    break;
  }

  // Priority 2: broader header/nav/logo class search — but still skip logo walls
  if (!logo) {
    var navImgs = Array.from(document.querySelectorAll(
      "header img, nav img, [class*='logo'] img, [id*='logo'] img, [class*='brand'] img"
    ));
    for (var nii2 = 0; nii2 < navImgs.length; nii2++) {
      var img2 = navImgs[nii2];
      if (isInLogoWall(img2)) continue;
      var imgW2 = img2.naturalWidth;
      var imgH2 = img2.naturalHeight;
      var imgSrc2 = img2.src || "";
      if (!imgSrc2 || imgSrc2.indexOf("data:") === 0) continue;
      var isSvgSrc2 = imgSrc2.split("?")[0].toLowerCase().endsWith(".svg");
      if (!isSvgSrc2 && (imgW2 === 0 || imgH2 === 0)) continue;
      if (imgW2 > 600 || imgH2 > 300) continue;
      if (imgSrc2.indexOf("background") !== -1 || imgSrc2.indexOf("hero") !== -1 || imgSrc2.indexOf("banner") !== -1) continue;
      logo = { type: "img", src: imgSrc2, alt: img2.alt, width: imgW2, height: imgH2, confidence: "high" };
      break;
    }
  }

  if (!logo) {
    var navSvgs = Array.from(document.querySelectorAll(
      "header svg, nav svg, [class*='logo'] svg, [id*='logo'] svg"
    ));
    for (var nsi = 0; nsi < navSvgs.length; nsi++) {
      if (isInLogoWall(navSvgs[nsi])) continue;
      var svgRect = navSvgs[nsi].getBoundingClientRect();
      if (svgRect.width > 400 || svgRect.height > 200) continue;
      logo = { type: "svg", outerHTML: navSvgs[nsi].outerHTML.slice(0, 800), confidence: "high" };
      break;
    }
  }

  if (!logo) {
    var topImgs = Array.from(document.querySelectorAll("img")).filter(function (img) {
      var r = img.getBoundingClientRect();
      var t = r.top + window.scrollY;
      return t < pageHeight * 0.15 && img.naturalWidth > 0 && img.naturalWidth < 400 && img.naturalHeight < 200;
    });
    if (topImgs.length > 0) {
      var ti = topImgs[0];
      logo = { type: "img", src: ti.src, alt: ti.alt, width: ti.naturalWidth, height: ti.naturalHeight, confidence: "medium" };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATS DISCOVERY (AND-validated)
  // ═══════════════════════════════════════════════════════════════════════

  var stats = [];
  var numericPattern = /^\$?[\d,]+(\.\d+)?[%+kKmMxX]?$|^[\d,]+(\.\d+)?(\s*(million|billion|thousand|%|\+|x))?$/i;

  var statCandidates = [];
  var allEls = Array.from(document.querySelectorAll("*"));
  for (var eli = 0; eli < allEls.length; eli++) {
    var elNode = allEls[eli];
    if (elNode.closest("nav, footer, form, script, style")) continue;
    var children = Array.from(elNode.children);
    if (children.length < 2) continue;
    var numericChild = null;
    var labelChild = null;
    for (var ci = 0; ci < children.length; ci++) {
      var childText = (children[ci].textContent || "").trim();
      if (numericPattern.test(childText) && childText.length < 20) numericChild = children[ci];
      else if (childText.length > 2 && childText.length < 80 && !numericPattern.test(childText)) labelChild = children[ci];
    }
    if (numericChild && labelChild) {
      statCandidates.push({
        value: (numericChild.textContent || "").trim(),
        label: (labelChild.textContent || "").trim(),
        parent: elNode.parentElement || elNode,
      });
    }
  }

  // AND condition: at least 2 stat pairs must share the same parent container
  var parentIndex = [];
  var parentCounts = [];
  for (var sci = 0; sci < statCandidates.length; sci++) {
    var idx = parentIndex.indexOf(statCandidates[sci].parent);
    if (idx === -1) { idx = parentIndex.length; parentIndex.push(statCandidates[sci].parent); parentCounts.push(0); }
    parentCounts[idx]++;
  }
  for (var sci2 = 0; sci2 < statCandidates.length; sci2++) {
    var pidx = parentIndex.indexOf(statCandidates[sci2].parent);
    if (parentCounts[pidx] >= 2 && !stats.find(function (s) { return s.value === statCandidates[sci2].value; })) {
      stats.push({ value: statCandidates[sci2].value, label: statCandidates[sci2].label });
    }
    if (stats.length >= 6) break;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TESTIMONIALS DISCOVERY (AND-validated)
  // ═══════════════════════════════════════════════════════════════════════

  var testimonials = [];
  var attributionPattern = /^[A-Z][a-z]+(\s[A-Z][a-z]+)*[,\s—\-]|CEO|Founder|Director|Manager|Co-founder/;

  for (var teli = 0; teli < allEls.length; teli++) {
    var telNode = allEls[teli];
    if (telNode.closest("nav, footer, form, script, style")) continue;
    var telChildren = Array.from(telNode.children);
    if (telChildren.length < 2) continue;
    var quoteChild = null;
    var authorChild = null;
    for (var tci = 0; tci < telChildren.length; tci++) {
      var tText = (telChildren[tci].textContent || "").trim();
      if (tText.length > 60 && tText.length < 500 && !numericPattern.test(tText.slice(0, 10))) quoteChild = telChildren[tci];
      else if (tText.length > 3 && tText.length < 80 && attributionPattern.test(tText)) authorChild = telChildren[tci];
    }
    if (quoteChild && authorChild) {
      var quote = (quoteChild.textContent || "").trim().replace(/^["'"']|["'"']$/g, "");
      var author = (authorChild.textContent || "").trim();
      if (!testimonials.find(function (t) { return t.quote === quote; })) testimonials.push({ quote: quote, author: author });
    }
    if (testimonials.length >= 4) break;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COPY TEXT, META, PHOTOGRAPHY
  // ═══════════════════════════════════════════════════════════════════════

  var copyText = {
    h1: Array.from(document.querySelectorAll("h1")).map(function (el) { return (el.textContent || "").trim(); }).filter(Boolean).slice(0, 5),
    h2: Array.from(document.querySelectorAll("h2")).map(function (el) { return (el.textContent || "").trim(); }).filter(Boolean).slice(0, 8),
    h3: Array.from(document.querySelectorAll("h3")).map(function (el) { return (el.textContent || "").trim(); }).filter(Boolean).slice(0, 8),
    nav: Array.from(document.querySelectorAll("nav a")).map(function (el) { return (el.textContent || "").trim(); }).filter(Boolean).slice(0, 10),
    cta: allButtons.filter(function (el) {
      var t = (el.textContent || "").trim();
      return t.length > 0 && t.length <= 50;
    }).map(function (el) { return (el.textContent || "").trim(); }).filter(Boolean).slice(0, 5),
    bodyParagraphs: Array.from(document.querySelectorAll("main p, section p, article p, [class*='hero'] p, [class*='content'] p"))
      .filter(function (el) { return !el.closest("nav, footer"); })
      .map(function (el) { return (el.textContent || "").trim(); })
      .filter(function (t) { return t.length > 30 && t.length < 400; })
      .slice(0, 8),
    listItems: Array.from(document.querySelectorAll("main li, section li, article li"))
      .filter(function (el) { return !el.closest("nav, footer"); })
      .map(function (el) { return (el.textContent || "").trim(); })
      .filter(function (t) { return t.length > 10 && t.length < 200; })
      .slice(0, 12),
  };

  var bodySnippet = document.body.innerText.slice(0, 4000);

  var faviconEl = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  var favicon = faviconEl ? faviconEl.href : "";
  var ogImageMeta = document.querySelector('meta[property="og:image"]');
  var ogImage = ogImageMeta ? (ogImageMeta.getAttribute("content") || "") : "";
  var ogTitleMeta = document.querySelector('meta[property="og:title"]');
  var ogTitle = ogTitleMeta ? (ogTitleMeta.getAttribute("content") || document.title) : document.title;
  var ogDescMeta = document.querySelector('meta[property="og:description"]');
  var ogDescription = ogDescMeta ? (ogDescMeta.getAttribute("content") || "") : "";
  var metaDescMeta = document.querySelector('meta[name="description"]');
  var metaDescription = metaDescMeta ? (metaDescMeta.getAttribute("content") || "") : "";
  var siteNameMeta = document.querySelector('meta[property="og:site_name"]');
  var rawSiteName = siteNameMeta ? (siteNameMeta.getAttribute("content") || "") : "";
  var genericNames = ["my site", "home", "website", "untitled", "wix site"];
  var brandName = genericNames.indexOf(rawSiteName.toLowerCase()) !== -1 ? "" : rawSiteName;

  // ═══════════════════════════════════════════════════════════════════════
  // BRAND ASSET IMAGES (content images, not nav/header/favicon)
  // ═══════════════════════════════════════════════════════════════════════

  // Collect all meaningful images: ≥100×100px, not in nav/header, not favicon/icon/avatar/logo
  var brandAssetImages = Array.from(document.querySelectorAll("img"))
    .filter(function (img) {
      var src = img.src || "";
      if (!src || src.indexOf("data:") === 0) return false;
      // Skip tiny images
      var renderedW = img.getBoundingClientRect().width;
      var renderedH = img.getBoundingClientRect().height;
      var naturalW = img.naturalWidth;
      var naturalH = img.naturalHeight;
      var effectiveW = naturalW || renderedW;
      var effectiveH = naturalH || renderedH;
      if (effectiveW < 100 || effectiveH < 100) return false;
      // Skip nav/header images (likely logos)
      if (img.closest("nav, header")) return false;
      // Skip favicon/icon/avatar/logo by URL pattern
      var srcLower = src.toLowerCase();
      if (/favicon|\.ico$|icon[\-_]|[\-_]icon|avatar|gravatar/.test(srcLower)) return false;
      // Skip very small logos by size
      if (effectiveW < 150 && effectiveH < 80) return false;
      return true;
    })
    .map(function (img) {
      var rect = img.getBoundingClientRect();
      var absTop = rect.top + window.scrollY;
      var src = img.src;
      // Determine file type
      var ext = "";
      try {
        var urlPath = new URL(src).pathname;
        var dotIdx = urlPath.lastIndexOf(".");
        if (dotIdx !== -1) ext = urlPath.slice(dotIdx + 1).toLowerCase().split("?")[0];
      } catch (e) {}
      return {
        src: src,
        alt: img.alt || "",
        width: img.naturalWidth || Math.round(rect.width),
        height: img.naturalHeight || Math.round(rect.height),
        ext: ext,
        isGif: ext === "gif",
        inHero: !!(img.closest('[class*="hero"], [class*="Hero"], section:first-of-type')),
        positionY: Math.round(absTop),
      };
    })
    // Sort: hero first, then by vertical position
    .sort(function (a, b) {
      if (a.inHero && !b.inHero) return -1;
      if (!a.inHero && b.inHero) return 1;
      return a.positionY - b.positionY;
    })
    .slice(0, 20);

  // Also collect CSS background images from content sections
  var bgImages = Array.from(document.querySelectorAll('[class*="hero"], [class*="Hero"], section, div'))
    .filter(function (el) { return !el.closest("nav, header, footer"); })
    .map(function (el) {
      var bg = window.getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none" && bg.indexOf("url(") !== -1) {
        var match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (match && match[1]) {
          var src = match[1];
          if (src.indexOf("data:") === 0) return null;
          if (/favicon|\.ico$/.test(src.toLowerCase())) return null;
          return src;
        }
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 5);

  // Legacy images field (for backward compat with classifyBrand)
  var images = brandAssetImages.slice(0, 15).map(function (img) {
    return { src: img.src, alt: img.alt, width: img.width, height: img.height, inHero: img.inHero };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TECH SIGNALS
  // ═══════════════════════════════════════════════════════════════════════

  var techSignals = [];

  // Platform detection from script sources
  var scriptSrcs = Array.from(document.querySelectorAll("script[src]")).map(function (s) { return s.src || ""; });
  var allScriptSrcs = scriptSrcs.join(" ").toLowerCase();

  var platformChecks = [
    { pattern: /wixstatic\.com|wix\.com/, label: "Wix" },
    { pattern: /webflow\.com|webflow\.io/, label: "Webflow" },
    { pattern: /squarespace\.com|sqsp\.net/, label: "Squarespace" },
    { pattern: /shopify\.com|myshopify\.com/, label: "Shopify" },
    { pattern: /wordpress\.com|wp-content|wp-includes/, label: "WordPress" },
    { pattern: /hubspot\.com|hs-scripts/, label: "HubSpot" },
    { pattern: /framer\.com|framerusercontent/, label: "Framer" },
    { pattern: /ghost\.io|ghost\.org/, label: "Ghost" },
    { pattern: /bubble\.io/, label: "Bubble" },
    { pattern: /nextjs|_next\/static/, label: "Next.js" },
    { pattern: /gatsby|gatsby-image/, label: "Gatsby" },
    { pattern: /react-dom|reactjs/, label: "React" },
    { pattern: /angular\.js|angular\.min/, label: "Angular" },
    { pattern: /vue\.js|vue\.min/, label: "Vue.js" },
  ];
  for (var pci = 0; pci < platformChecks.length; pci++) {
    if (platformChecks[pci].pattern.test(allScriptSrcs) || platformChecks[pci].pattern.test(window.location.href)) {
      techSignals.push(platformChecks[pci].label + "-based website");
    }
  }

  // Analytics & marketing tools
  var analyticsChecks = [
    { pattern: /google-analytics|gtag|googletagmanager/, label: "Google Analytics" },
    { pattern: /segment\.com|segment\.io/, label: "Segment" },
    { pattern: /mixpanel\.com/, label: "Mixpanel" },
    { pattern: /intercom\.io|intercom\.com/, label: "Intercom" },
    { pattern: /drift\.com/, label: "Drift" },
    { pattern: /hotjar\.com/, label: "Hotjar" },
    { pattern: /hubspot\.com/, label: "HubSpot CRM" },
    { pattern: /salesforce\.com|pardot/, label: "Salesforce" },
    { pattern: /marketo\.com/, label: "Marketo" },
    { pattern: /linkedin\.com\/insight/, label: "LinkedIn Insight" },
    { pattern: /facebook\.net\/en_US\/fbevents/, label: "Facebook Pixel" },
    { pattern: /stripe\.com/, label: "Stripe payments" },
  ];
  for (var aci = 0; aci < analyticsChecks.length; aci++) {
    if (analyticsChecks[aci].pattern.test(allScriptSrcs)) {
      techSignals.push(analyticsChecks[aci].label);
    }
  }

  // Social presence from footer links
  var allLinks = Array.from(document.querySelectorAll("a[href]")).map(function (a) { return a.href || ""; });
  var allLinksStr = allLinks.join(" ").toLowerCase();
  var socialPlatforms = [];
  if (/linkedin\.com\/company/.test(allLinksStr)) socialPlatforms.push("LinkedIn");
  if (/twitter\.com|x\.com/.test(allLinksStr)) socialPlatforms.push("X/Twitter");
  if (/instagram\.com/.test(allLinksStr)) socialPlatforms.push("Instagram");
  if (/facebook\.com/.test(allLinksStr)) socialPlatforms.push("Facebook");
  if (/youtube\.com/.test(allLinksStr)) socialPlatforms.push("YouTube");
  if (/tiktok\.com/.test(allLinksStr)) socialPlatforms.push("TikTok");
  if (socialPlatforms.length > 0) {
    techSignals.push("Social presence on " + socialPlatforms.join(", "));
  }

  // App store links
  if (/apps\.apple\.com|itunes\.apple\.com/.test(allLinksStr)) techSignals.push("iOS app available");
  if (/play\.google\.com/.test(allLinksStr)) techSignals.push("Android app available");

  // Subdomains referenced
  var subdomainMatches = allLinks
    .map(function (href) {
      try {
        var u = new URL(href);
        var host = u.hostname;
        var base = window.location.hostname.replace(/^www\./, "");
        if (host !== window.location.hostname && host.endsWith("." + base)) {
          return host;
        }
      } catch (e) {}
      return null;
    })
    .filter(Boolean);
  var uniqueSubdomains = subdomainMatches.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 3);
  uniqueSubdomains.forEach(function (sub) {
    techSignals.push("Subdomain: " + sub);
  });

  // AI/ML signals
  if (/openai|gpt|claude|anthropic|llm|embedding|vector|ai.companion|ai.assistant/.test(allScriptSrcs + bodySnippet.toLowerCase())) {
    techSignals.push("AI/ML layer detected");
  }

  // Persist raw, privacy-safe artifacts for the separate Company Intelligence
  // Tech Stack module. Values from cookies are never retained—only cookie names.
  var techArtifacts = {
    scriptUrls: scriptSrcs.filter(Boolean).slice(0, 120),
    generators: Array.from(document.querySelectorAll('meta[name="generator"]')).map(function (meta) { return meta.content || ''; }).filter(Boolean).slice(0, 12),
    cookieNames: document.cookie.split(';').map(function (cookie) { return cookie.trim().split('=')[0]; }).filter(Boolean).slice(0, 60),
    globals: ['Shopify', 'dataLayer', 'Intercom', 'analytics', 'hj', 'fbq', 'OneSignal', '__NEXT_DATA__', '__NUXT__', 'Sentry', 'mixpanel', 'segment'].filter(function (name) { return name in window; }),
    networkHosts: Array.from(performance.getEntriesByType('resource')).map(function (entry) { try { return new URL(entry.name).hostname; } catch (e) { return null; } }).filter(Boolean).filter(function (host, index, values) { return values.indexOf(host) === index; }).slice(0, 120)
  };

  // ═══════════════════════════════════════════════════════════════════════
  // SPATIAL & SHAPE
  // ═══════════════════════════════════════════════════════════════════════

  function spatialFor(selector) {
    var el = document.querySelector(selector);
    if (!el) return null;
    var cs = window.getComputedStyle(el);
    function parseVal(v) { return parseFloat(v) || 0; }
    return {
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      avgPadding: (parseVal(cs.paddingTop) + parseVal(cs.paddingBottom) + parseVal(cs.paddingLeft) + parseVal(cs.paddingRight)) / 4,
      avgMargin: (parseVal(cs.marginTop) + parseVal(cs.marginBottom)) / 2,
    };
  }
  var spatial = spatialFor("body") || spatialFor("section") || { avgPadding: 16, avgMargin: 8 };

  var borderRadii = [];
  for (var bri = 0; bri < Math.min(allButtons.length, 5); bri++) {
    var r = window.getComputedStyle(allButtons[bri]).borderRadius;
    if (r && r !== "0px") borderRadii.push(r);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════════════════════════════

  return {
    url: window.location.href,
    title: document.title,
    brandName: brandName,
    ogTitle: ogTitle,
    ogImage: ogImage,
    ogDescription: ogDescription,
    metaDescription: metaDescription,
    favicon: favicon,
    scoredPalette: scoredPalette,
    backgroundColor: bodyBg,
    discoveredFonts: discoveredFonts,
    fontElementMap: fontElementMap,
    fontFileUrls: fontFileUrls,
    logo: logo,
    borderRadii: borderRadii,
    copyText: copyText,
    bodySnippet: bodySnippet,
    stats: stats,
    testimonials: testimonials,
    images: images,
    bgImages: bgImages,
    brandAssetImages: brandAssetImages,
    techSignals: techSignals,
    techArtifacts: techArtifacts,
    spatial: spatial,
    colorSamples: scoredPalette.map(function (c) { return { hex: c.hex, contexts: c.sources, count: c.score }; }),
    logoImgs: logo && logo.type === "img" ? [{ src: logo.src, alt: logo.alt, width: logo.width, height: logo.height }] : [],
    logoSvgs: logo && logo.type === "svg" ? [{ type: "inline-svg", outerHTML: logo.outerHTML }] : [],
  };
};
