// perf — the page-speed levers checkable from source:
//   1. public/_headers marks content-hashed assets (/_astro/*) immutable, so
//      repeat visits don't re-validate every JS/CSS/font.
//   2. Content <img> tags carry width + height (no layout shift / CLS).
//      <Image> from astro:assets bakes these in; raw <img> without them shifts.
//   3. Render-blocking CSS + webfont weight, measured on the built output.
//   4. Heavy third-party embeds are behind a facade, not loaded with the page.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

import { attrValue, hasAttr, eachDistHtml, srcsetUrls } from '../lib/html.mjs';
import { SKIP_DIST, distDir, distRelative } from '../lib/dist.mjs';
import { astroBlock, MIN_IMMUTABLE_MAXAGE, CANONICAL_MAXAGE } from '../lib/headers.mjs';
import { embedProduct, fetchableMarkup } from '../lib/embed-hosts.mjs';
import { fontFamilies } from '../lib/fonts-config.mjs';
import { imageSize } from '../lib/image-size.mjs';
import { copyFromStarter, editFile } from '../lib/remedy.mjs';
import { outOfFlowSelectors, inlineStyles, isOutOfFlow } from '../lib/css-flow.mjs';
import { truncate } from '../lib/text.mjs';
import { walkFiles } from '../lib/walk.mjs';

const SEC = 'perf';

const SCAN_EXTS = new Set(['.astro', '.tsx', '.jsx', '.html', '.md', '.mdx']);
const CONTENT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);
const SVG_OR_FAVICON_RE = /\.(svg|ico)$|\bfavicon\b/i;

export async function run({ project, reporter }) {
  checkHeaders(project, reporter);
  checkCls(project, reporter);
  checkWeight(project, reporter);
  checkEmbeds(project, reporter);
  checkCrossOrigin(project, reporter);
}

// 1. public/_headers — hashed assets immutable -------------------------------

function checkHeaders(project, reporter) {
  const path = join(project.root, 'public', '_headers');
  if (!existsSync(path)) {
    // The one starter file with no coupling to the project around it: pure
    // static text, no imports, no collection names, no layout. Every other
    // artifact the baseline asks for reaches back into og.config or a layout,
    // which is why this is the only `copy` remedy in the tool.
    reporter.fix(SEC, '_headers', 'public/_headers missing — hashed bundles served max-age=0 (every repeat visit re-validates all JS/CSS)', 'add public/_headers marking /_astro/* immutable',
      { remedy: copyFromStarter('public/_headers') });
    return;
  }

  const block = astroBlock(project.root);
  if (!block) {
    reporter.fix(SEC, '_headers:/_astro/*', 'no /_astro/* rule — content-hashed bundles not marked immutable', 'add a /_astro/* block to public/_headers');
    return;
  }

  const cc = block.headers['cache-control'] ?? '';
  const hasImmutable = /\bimmutable\b/.test(cc);
  const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1] ?? 0);
  if (hasImmutable && maxAge >= MIN_IMMUTABLE_MAXAGE) {
    reporter.pass(SEC, '_headers:/_astro/*', maxAge >= CANONICAL_MAXAGE ? '1yr immutable' : `${maxAge}s immutable`);
  } else {
    const missing = [
      !hasImmutable ? 'immutable' : null,
      maxAge < MIN_IMMUTABLE_MAXAGE ? `max-age (${maxAge}s, need ≥${MIN_IMMUTABLE_MAXAGE})` : null,
    ].filter(Boolean).join(' + ');
    reporter.fix(SEC, '_headers:/_astro/*', `Cache-Control missing ${missing}`, 'set "Cache-Control: public, max-age=31536000, immutable" on /_astro/*');
  }
}

// 2. CLS — content <img> tags need width + height ----------------------------

function checkCls(project, reporter) {
  const offenders = [];
  let scanned = 0, outOfFlow = 0;
  const flow = sourceOutOfFlow(project.root);
  walkSource(project.root, (relPath) => {
    if (!SCAN_EXTS.has(extname(relPath).toLowerCase())) return;
    let text;
    try { text = readFileSync(join(project.root, relPath), 'utf8'); }
    catch { return; }   // unreadable file — skip it, never lose the domain
    const re = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const attrs = m[1];
      const src = attrValue(attrs, 'src') ?? '';
      if (!isContentImageRef(src)) continue;
      scanned++;
      // A *value* is required here, not mere presence: a bare `width` reserves
      // no space, so it cannot prevent the layout shift this check exists for.
      if (attrValue(attrs, 'width') != null && attrValue(attrs, 'height') != null) continue;
      // …but an out-of-flow image has nothing to shift, and width/height would
      // be overridden anyway. See lib/css-flow.mjs for why this carve-out exists.
      if (isOutOfFlow(attrs, flow)) { outOfFlow++; continue; }
      offenders.push({ file: relPath, line: lineOf(text, m.index), src, tag: m[0], attrs });
    }
  });

  const aside = outOfFlow ? ` (${outOfFlow} absolutely positioned — out of flow, nothing to shift)` : '';
  if (scanned === 0) {
    reporter.skip(SEC, 'cls:img-dimensions', 'no raw content <img> in src/ — nothing to check (<Image> bakes dimensions in)');
  } else if (offenders.length === 0) {
    reporter.pass(SEC, 'cls:img-dimensions', `all ${scanned} content <img> reserve their space${aside}`);
  } else {
    for (const o of offenders) {
      // The remedy exists only when the image's OWN BYTES answered the question.
      // That is the bar from lib/remedy.mjs: intrinsic width and height are a
      // measurement this tool already knows how to take, not a guess. A remote
      // src, or a format image-size.mjs cannot read, gets the prose and no
      // remedy — which is the honest outcome, not a degraded one.
      const dims = intrinsic(project.root, o);
      reporter.fix(SEC, 'cls:img-dimensions', `<img src="${truncate(o.src, 60)}"> lacks width/height → layout shift (CLS)`, 'use <Image> from astro:assets (bakes width/height), or add explicit width + height',
        { file: o.file, line: o.line, ...(dims ? { remedy: editFile(o.file, o.tag, withDimensions(o, dims)) } : {}) });
    }
  }
}

/**
 * The image's intrinsic size, read off disk, or null.
 *
 * Only local images: `/x.png` is public/, anything relative resolves against
 * the file that referenced it, and a remote URL is not fetched — an offline
 * check does not go to the network, and a fix that depends on someone else's
 * server is not deterministic anyway.
 */
function intrinsic(root, { src, file }) {
  if (/^(?:[a-z]+:)?\/\//i.test(src)) return null;
  const path = src.startsWith('/')
    ? join(root, 'public', src.slice(1))
    : join(root, file, '..', src);
  try { return imageSize(readFileSync(path)); } catch { return null; }
}

/**
 * The same tag with the missing dimension attributes inserted.
 *
 * Only the missing ones: this check fires when EITHER is absent, so a tag that
 * already declares a width must not get a second one. Inserted right after
 * `<img`, which is the one position that is correct regardless of how the rest
 * of the tag is written.
 */
function withDimensions({ tag, attrs }, { w, h }) {
  const add = [
    attrValue(attrs, 'width') == null ? ` width="${w}"` : '',
    attrValue(attrs, 'height') == null ? ` height="${h}"` : '',
  ].join('');
  return tag.replace(/^<img/i, `<img${add}`);
}

// Every stylesheet the source carries: the `<style>` blocks inside components
// (where an Astro-scoped rule lives) plus standalone .css under src/. Read once
// per run — a positioning rule is usually in a different file from the <img>.
function sourceOutOfFlow(root) {
  const css = [];
  walkSource(root, (relPath) => {
    const ext = extname(relPath).toLowerCase();
    if (ext !== '.css' && !SCAN_EXTS.has(ext)) return;
    let text;
    try { text = readFileSync(join(root, relPath), 'utf8'); }
    catch { return; }
    if (ext === '.css') css.push(text);
    else css.push(...inlineStyles(text));
  });
  return outOfFlowSelectors(css);
}

function isContentImageRef(src) {
  if (!src || SVG_OR_FAVICON_RE.test(src)) return false;
  if (src.startsWith('data:') || src.startsWith('blob:')) return false;
  const ext = extname(src.split('?')[0]).toLowerCase();
  if (CONTENT_IMAGE_EXTS.has(ext)) return true;
  if (/^https?:\/\/media\./.test(src)) return true;
  return false;
}

function walkSource(root, callback) {
  const skip = (n) => n === 'node_modules' || n === 'dist' || n.startsWith('.');
  for (const full of walkFiles(join(root, 'src'), { skip })) callback(relative(root, full));
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}


// 3. Payload weight — CSS and fonts -------------------------------------------
//
// Both are render-blocking and both are trivially measurable from dist/. Nothing
// checked either: modules:fonts only detects a third-party font *CDN*.
//
// CSS is measured PER PAGE, not across dist/. Astro emits a stylesheet per route,
// so a 484-page site legitimately has dozens of .css files while any single page
// links two — totalling the directory would punish a site for having pages.

const CSS_BYTES_SUGGEST = 100 * 1024;
const CSS_BYTES_FIX     = 250 * 1024;
const CSS_LINKS_SUGGEST = 3;
const FONT_FAMILIES_SUGGEST = 2;
const FONT_FACES_SUGGEST    = 4;
const FONT_BYTES_SUGGEST = 200 * 1024;
const FONT_BYTES_FIX     = 500 * 1024;

const FONT_FILE_RE = /\.(woff2|woff|ttf|otf|eot)$/i;
const LEGACY_FONT_RE = /\.(ttf|otf|eot)$/i;

export function checkWeight(project, reporter) {
  if (!project.hasDist) {
    reporter.skip(SEC, 'css:bytes', 'no dist/ — build the site to measure the CSS it ships');
    reporter.skip(SEC, 'font:bytes', 'no dist/ — build the site to measure the fonts it ships');
    return;
  }
  const files = distTree(distDir(project.root));
  checkCssWeight(project, reporter, files);
  checkFontWeight(project, reporter, files);
  checkDeclaredFamilies(project, reporter, files);
}

/**
 * A declared family that can never paint, and one that ships italic for nothing.
 *
 * Both cost real bytes and neither shows up in a byte total, because the total
 * is correct — it is the *composition* that is wrong. tasmanvisa-web declared
 * `Inter` in `fonts[]` and put it second in the `--font-sans` stack, behind a
 * self-hosted, preloaded `Sora`. It could only ever render if Sora failed to
 * load, and it was downloaded eagerly on every page: 277 KB, 143 KB of it italic
 * faces nothing referenced.
 */
function checkDeclaredFamilies(project, reporter, files) {
  const families = fontFamilies(project.astroConfig);
  if (families.length === 0) {
    // Both, not just the first: a check that emits nothing is indistinguishable
    // from one that did not run.
    reporter.skip(SEC, 'font:unused-family', 'no fonts[] in astro.config — nothing declared to trace into the CSS');
    reporter.skip(SEC, 'font:styles', 'no fonts[] in astro.config — nothing declared whose styles could default to [normal, italic]');
    return;
  }

  const css = files.filter((f) => /\.(css|html)$/i.test(f))
    .map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })
    .join('\n');

  const dead = [];
  const fallbackOnly = [];
  for (const fam of families) {
    if (!fam.cssVariable) continue;
    const positions = stackPositions(css, fam.cssVariable);
    if (positions.length === 0) dead.push(fam);
    else if (!positions.includes(0)) fallbackOnly.push(fam);
  }

  const named = (f) => `${f.name ?? '(unnamed)'} (${f.cssVariable})`;
  if (fallbackOnly.length === 0 && dead.length === 0) {
    reporter.pass(SEC, 'font:unused-family', `all ${families.length} declared famil${families.length === 1 ? 'y leads a' : 'ies lead a'} font-family stack`);
  }
  for (const f of fallbackOnly) {
    reporter.fix(SEC, 'font:unused-family', `${named(f)} never leads a font-family stack — it is a webfont downloaded on every page that can only render if the font ahead of it fails`, "drop it from fonts[] and let Astro's metric-adjusted local fallback do that job, or move it to the front of the stack if it is the font you meant");
  }
  for (const f of dead) {
    reporter.suggest(SEC, 'font:unused-family', `${named(f)} is declared in fonts[] but its variable appears in no font-family stack in the built CSS`, 'remove it from fonts[], or apply it — as declared it is downloaded and never used');
  }

  // `styles` defaults to ['normal','italic'] (astro/dist/assets/fonts/constants.js),
  // so a family declared without it silently doubles its file count. Except a
  // local() family: its `variants` ARE the style list, one face per variant,
  // and there is no default to fall foul of. tasmanvisa-web's Caveat shipped one
  // normal face and was reported as building italic ones (#39).
  const remote = families.filter((f) => !f.local);
  const implicit = remote.filter((f) => !f.hasStyles);
  if (remote.length === 0) {
    reporter.pass(SEC, 'font:styles', `all ${families.length} declared famil${families.length === 1 ? 'y is' : 'ies are'} local() — their variants name each style, so there is no default to omit`);
    return;
  }
  if (implicit.length === 0) {
    const local = families.length - remote.length;
    reporter.pass(SEC, 'font:styles', `all ${remote.length} provider-fetched famil${remote.length === 1 ? 'y sets' : 'ies set'} styles explicitly${local ? ` (${local} local() famil${local === 1 ? 'y lists' : 'ies list'} its own variants)` : ''}`);
    return;
  }
  // <em>, <i> and friends render italic from the UA stylesheet with no CSS at
  // all, so "no font-style: italic in the CSS" is not evidence on its own —
  // asserting it would flag a blog with emphasis in its prose.
  const italicUsed = /font-style\s*:\s*(italic|oblique)/i.test(css)
    || /<(?:em|i|cite|dfn|var|address)\b/i.test(css);
  if (italicUsed) {
    reporter.suggest(SEC, 'font:styles', `${implicit.length} declared famil${implicit.length === 1 ? 'y omits' : 'ies omit'} styles, so italic faces are built for ${implicit.length === 1 ? 'it' : 'them'} too (the default is [normal, italic]) — ${implicit.map(named).join(', ')}`, 'set styles: ["normal"] on the families that never render italic; the axis that costs bytes is family × style × subset, not weight (a variable font covers a whole weight range in one file)');
  } else {
    reporter.fix(SEC, 'font:styles', `${implicit.length} declared famil${implicit.length === 1 ? 'y omits' : 'ies omit'} styles, so italic faces ship (the default is [normal, italic]) — and nothing in the built output renders italic: no font-style: italic, no <em>/<i>/<cite> — ${implicit.map(named).join(', ')}`, 'set styles: ["normal"] on them; the axis that costs bytes is family × style × subset, not weight (a variable font covers a whole weight range in one file)');
  }
}

/**
 * Where `var(--x)` sits in each comma-separated stack it appears in.
 *
 * Index 0 means it leads a stack — the font that actually paints. Anything else
 * means it only renders if everything before it fails to load, which for a
 * self-hosted webfont means never.
 */
function stackPositions(css, cssVariable) {
  const out = [];
  const useRe = new RegExp(`var\\(\\s*${cssVariable.replace(/[-]/g, '\\-')}\\s*[,)]`, 'g');
  for (const m of css.matchAll(useRe)) {
    // Back up to the start of this declaration's value, then count the commas
    // that are not inside a var()/quotes before our position.
    const declStart = Math.max(css.lastIndexOf(':', m.index), css.lastIndexOf(';', m.index), css.lastIndexOf('{', m.index));
    const value = css.slice(declStart + 1, m.index);
    let depth = 0, commas = 0;
    for (const ch of value) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) commas++;
    }
    out.push(commas);
  }
  return out;
}

function checkCssWeight(project, reporter, files) {
  const dist = distDir(project.root);
  const pages = files.filter((f) => f.endsWith('.html'));
  if (pages.length === 0) {
    reporter.skip(SEC, 'css:bytes', 'no built HTML — nothing to measure');
    return;
  }

  let worst = { bytes: 0, page: null }, mostLinks = { n: 0, page: null };
  for (const page of pages) {
    let html;
    try { html = readFileSync(page, 'utf8'); } catch { continue; }
    const hrefs = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
      .map((m) => m[0].match(/href=["']([^"']+)["']/)?.[1])
      .filter(Boolean);
    let bytes = 0;
    for (const href of hrefs) {
      if (/^https?:/i.test(href)) continue;   // a third-party sheet: not ours to size
      bytes += sizeOf(join(dist, href.replace(/^\//, '')));
    }
    // Inlined <style> counts: Astro inlines small stylesheets, and those bytes
    // are just as render-blocking as a linked file.
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) bytes += Buffer.byteLength(m[1], 'utf8');
    const rel = relative(project.root, page);
    if (bytes > worst.bytes) worst = { bytes, page: rel };
    if (hrefs.length > mostLinks.n) mostLinks = { n: hrefs.length, page: rel };
  }

  const at = worst.page ? { file: worst.page } : {};
  if (worst.bytes > CSS_BYTES_FIX) {
    reporter.fix(SEC, 'css:bytes', `${humanKB(worst.bytes)} of render-blocking CSS on the heaviest page — over the ${humanKB(CSS_BYTES_FIX)} budget`, 'this is usually an unpurged framework: enable the purge/content scan so only used rules ship', at);
  } else if (worst.bytes > CSS_BYTES_SUGGEST) {
    reporter.suggest(SEC, 'css:bytes', `${humanKB(worst.bytes)} of render-blocking CSS on the heaviest page (soft budget ${humanKB(CSS_BYTES_SUGGEST)})`, 'check whether a framework is shipping rules the page never uses', at);
  } else {
    reporter.pass(SEC, 'css:bytes', `heaviest page ships ${humanKB(worst.bytes)} of CSS`, at);
  }

  if (mostLinks.n > CSS_LINKS_SUGGEST) {
    reporter.fix(SEC, 'css:files', `${mostLinks.n} render-blocking stylesheets on one page`, 'each one is a separate round-trip before first paint — bundle them', { file: mostLinks.page });
  } else {
    reporter.pass(SEC, 'css:files', `at most ${mostLinks.n} stylesheet link(s) per page`);
  }
}

function checkFontWeight(project, reporter, files) {
  const fontFiles = files.filter((f) => FONT_FILE_RE.test(f));
  const bytes = fontFiles.reduce((s, f) => s + sizeOf(f), 0);

  // @font-face blocks, deduped by content: the same block is repeated in every
  // page's inlined <style>, so counting occurrences across dist/ multiplies by
  // the page count (2904 of them on a real 484-page site).
  const blocks = new Set();
  for (const f of files) {
    if (!/\.(css|html)$/i.test(f)) continue;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/@font-face\s*\{[\s\S]*?\}/gi)) blocks.add(m[0].replace(/\s+/g, ' '));
  }

  // Astro's Fonts API emits a second @font-face per family carrying fallback
  // metrics — its family name contains "fallback:". Counting those as real
  // families reported every correctly-configured two-font site as having four.
  const real = [...blocks].filter((b) => !/font-family\s*:\s*["']?[^;"'}]*fallback:/i.test(b));
  const families = new Set();
  for (const b of real) {
    const name = b.match(/font-family\s*:\s*["']?([^;"'}]+)/i)?.[1]?.trim().toLowerCase();
    // Astro hashes the family name (`outfit-cce106cc3d487109`); one family, one name.
    if (name) families.add(name.replace(/-[0-9a-f]{8,}$/, ''));
  }

  if (fontFiles.length === 0 && real.length === 0) {
    reporter.skip(SEC, 'font:bytes', 'no webfonts in dist/ — nothing to measure');
    return;
  }

  if (bytes > FONT_BYTES_FIX) {
    reporter.fix(SEC, 'font:bytes', `${humanKB(bytes)} of webfonts in ${fontFiles.length} file(s) — over the ${humanKB(FONT_BYTES_FIX)} budget`, 'subset to the characters actually used, drop unused weights, and prefer one variable font over four static ones');
  } else if (bytes > FONT_BYTES_SUGGEST) {
    reporter.suggest(SEC, 'font:bytes', `${humanKB(bytes)} of webfonts in ${fontFiles.length} file(s) (soft budget ${humanKB(FONT_BYTES_SUGGEST)})`, 'subsetting or a variable font usually halves this');
  } else {
    reporter.pass(SEC, 'font:bytes', `${humanKB(bytes)} of webfonts in ${fontFiles.length} file(s)`);
  }

  if (families.size > FONT_FAMILIES_SUGGEST) {
    reporter.fix(SEC, 'font:families', `${families.size} font families (${[...families].join(', ')})`, 'two families — one for headings, one for body — is enough for almost any content site');
  } else {
    reporter.pass(SEC, 'font:families', `${families.size} font ${families.size === 1 ? 'family' : 'families'}`);
  }

  // Count the FILES the declarations point at, not the declarations. A
  // variable family declared at several weights emits one @font-face per
  // weight, all resolving to the same woff2 — Geist Mono's four declarations
  // were one file, and a static family asked for a weight range expands to a
  // face per published weight. Counting declarations punished the config
  // Astro's docs recommend and rewarded a workaround (#39). The first url() in
  // a src is the file a browser fetches; the rest are format alternatives it
  // skips. A local()-only face downloads nothing and is not counted.
  const faceFiles = new Set();
  for (const b of real) {
    const src = b.match(/\bsrc\s*:([^;}]*)/i)?.[1] ?? '';
    const first = src.match(/url\(\s*["']?([^"')]+)/i)?.[1];
    if (first) faceFiles.add(first.trim());
  }
  const declared = `${real.length} @font-face declaration${real.length === 1 ? '' : 's'}`;
  if (faceFiles.size > FONT_FACES_SUGGEST) {
    reporter.fix(SEC, 'font:faces', `${faceFiles.size} font files across ${declared}`, 'each file is a separate download — a variable font covers a whole weight range in one, and a static family needs only the weights the design uses');
  } else {
    reporter.pass(SEC, 'font:faces', `${faceFiles.size} font file(s) across ${declared}`);
  }

  const legacy = fontFiles.filter((f) => LEGACY_FONT_RE.test(f));
  if (legacy.length) {
    reporter.fix(SEC, 'font:format', `${legacy.length} font file(s) served as ttf/otf/eot`, 'convert to woff2 — universally supported for years and roughly half the bytes', { file: relative(project.root, legacy[0]) });
  } else {
    reporter.pass(SEC, 'font:format', 'all webfonts are woff2/woff');
  }
}

// 4. Heavy third-party embeds behind a facade --------------------------------

/**
 * A heavy third-party iframe in the built HTML is, by definition, loaded with
 * the page — a facade injects the frame at scroll time, so a compliant site has
 * nothing here to find.
 *
 * `loading="lazy"` deliberately does not exempt one. It defers only frames far
 * enough down, and the measured case (cypruspokerbrisbane.com) had the map in
 * the *second section*, inside the threshold: the attribute was present, the
 * 360 KB was fetched anyway, and mobile Performance sat at 70 until the embed
 * went behind an IntersectionObserver facade (then 97).
 */
function checkEmbeds(project, reporter) {
  if (!project.hasDist) {
    reporter.skip(SEC, 'embed:eager', 'no dist/ — build the site to check for eagerly-loaded third-party embeds');
    return;
  }

  let iframes = 0;
  const found = [];
  const seen = new Set();
  eachDistHtml(project.root, (rel, html) => {
    for (const m of fetchableMarkup(html).matchAll(/<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      iframes++;
      const src = attrValue(m[1], 'src') ?? attrValue(m[1], 'data-src');
      if (!src) continue;
      const product = embedProduct(src);
      if (!product) continue;
      // One finding per embed, not per page: a component rendered on 400 pages
      // is one edit. First page wins as the place to look.
      const key = `${product}|${src.split(/[?#]/)[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ product, src, page: distRelative(project.root, rel), lazy: /\bloading\s*=\s*["']?lazy/i.test(m[1]) });
    }
  });

  if (found.length === 0) {
    reporter.pass(SEC, 'embed:eager', iframes === 0
      ? 'no <iframe> in the built pages'
      : `none of the ${iframes} built <iframe>(s) is a heavy third-party embed`);
    return;
  }
  for (const f of found) {
    const lazyNote = f.lazy
      ? ' — loading="lazy" does not defer it: native lazy loading has a generous near-viewport threshold, and an embed high on the page falls inside it (measured)'
      : '';
    reporter.fix(
      SEC,
      'embed:eager',
      `${f.product} embed loads with the page${lazyNote} (${truncate(f.src, 90)})`,
      'replace it with a facade — render a static placeholder (an image or a styled box) and inject the <iframe> from an IntersectionObserver when the user scrolls near it. Keeping the real frame in a <template> or <noscript> is fine; neither is fetched',
      { file: f.page },
    );
  }
}

// 5. Cross-origin images: preconnect, and a preload that matches -------------

/**
 * Images from another origin need the connection opened early.
 *
 * The browser only starts DNS + TLS for a host once it parses a URL pointing at
 * it, so on a 150 ms-RTT mobile link that is several round trips of dead time
 * before a single byte of the LCP image moves. tasmanvisa-web served every blog
 * hero and card from `media.tasmanvisa.com` with no preconnect anywhere: blog
 * index LCP 5424 ms, and ~3500 ms once a preconnect plus a matching head preload
 * were added.
 *
 * The site's own origin is read from each page's canonical link — the page's own
 * statement of where it lives — falling back to `site:` in astro.config. A page
 * that declares neither cannot be judged and is not counted.
 */
function checkCrossOrigin(project, reporter) {
  if (!project.hasDist) {
    reporter.skip(SEC, 'preconnect', 'no dist/ — build the site to check cross-origin image hosts');
    return;
  }
  const configSite = project.astroConfig?.match(/\bsite\s*:\s*(['"`])(https?:\/\/[^'"`]+)\1/)?.[2]
    ?? project.ogConfig?.siteUrl ?? null;

  // host → { images: Set<url>, cors: bool, preconnect: 'crossorigin' | 'bare' | null, page }
  // `cors` is whether any <img>/<source> on the host carries a crossorigin
  // attribute — the fetch mode the preconnect has to match (see reportPreconnect).
  const hosts = new Map();
  const preloadIssues = [];
  // How many `preload as=image` links were seen at all — the difference between
  // "every preload matches its <img>" and "there were no preloads", which this
  // check used to report identically by saying nothing in both cases.
  const preloads = { count: 0 };
  let pagesJudged = 0;

  eachDistHtml(project.root, (rel, html) => {
    const origin = pageOrigin(html, configSite);
    if (!origin) return;
    pagesJudged++;
    const page = distRelative(project.root, rel);
    const head = html.split(/<\/head>/i)[0] ?? html;
    const links = [...head.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)].map((m) => m[1]);

    // Which hosts THIS page preconnects to, before its images are judged: the
    // hint only helps the page that carries it. Aggregating one flag per host
    // across the whole site meant a homepage-only preconnect satisfied a blog
    // page loading twenty images from that host — which is the tasmanvisa
    // scenario this check was built from, silently passing.
    const preconnected = new Map();
    for (const attrs of links) {
      if (!/(?:^|\s)preconnect(?:\s|$)/i.test(attrValue(attrs, 'rel') ?? '')) continue;
      const href = attrValue(attrs, 'href');
      if (!href) continue;
      let target;
      try { target = new URL(href, origin).origin; } catch { continue; }
      if (!preconnected.has(target)) preconnected.set(target, hasAttr(attrs, 'crossorigin') ? 'crossorigin' : 'bare');
    }

    const onThisPage = new Map();   // origin → { elements:Set, cors:bool, noCors:bool, sample }
    for (const { url, cors, el } of imageUrls(html)) {
      let host;
      try { host = new URL(url, origin); } catch { continue; }
      if (host.origin === origin) continue;
      const seen = onThisPage.get(host.origin) ?? { elements: new Set(), cors: false, noCors: false, sample: host.href };
      seen.elements.add(el);
      if (cors) seen.cors = true; else seen.noCors = true;
      onThisPage.set(host.origin, seen);
    }

    for (const [target, seen] of onThisPage) {
      const entry = hosts.get(target) ?? { maxImages: 0, cors: false, noCors: false, pages: 0, missingOn: [], declared: new Map(), page };
      entry.maxImages = Math.max(entry.maxImages, seen.elements.size);
      entry.cors ||= seen.cors;
      entry.noCors ||= seen.noCors;
      entry.pages++;
      const mode = preconnected.get(target) ?? null;
      if (mode === null) { entry.missingOn.push(page); if (entry.missingOn.length === 1) entry.page = page; }
      else if (!entry.declared.has(mode)) entry.declared.set(mode, page);
      hosts.set(target, entry);
    }
    // A preconnect to a host this page loads no images from is not this check's
    // business (a font or an API origin), so it is recorded only above.

    collectPreloadMismatches(head, html, page, preloadIssues, preloads);
  });

  reportPreconnect(hosts, pagesJudged, reporter);
  reportPreloadPairs(preloadIssues, preloads.count, reporter);
}

function pageOrigin(html, configSite) {
  const canonical = html.match(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
  const href = canonical ? attrValue(canonical.replace(/^<link/i, ''), 'href') : null;
  for (const candidate of [href, configSite]) {
    if (!candidate) continue;
    try { return new URL(candidate).origin; } catch { /* relative canonical — try the next */ }
  }
  return null;
}

/**
 * Every image URL a document references — <img src|srcset>, <source srcset>,
 * inline background-image — carrying the index of the ELEMENT it came from and
 * whether that element fetches in CORS mode (a `crossorigin` attribute). A CSS
 * background is always no-cors.
 *
 * `el` exists because the caller counts images, and a Set of URLs is not a count
 * of images: one avatar written with a two-rung srcset produced three entries
 * and pushed a single incidental image into the required-fix branch — the exact
 * opposite of the carve-out `reportPreconnect` documents.
 *
 * A `<source>` contributes its `srcset` only. That is what discriminates a
 * `<picture>` source from a `<video>`/`<audio>` one, which carries `src` +
 * `type` and no srcset — otherwise two media files on a CDN were reported as
 * "2 images load from …".
 */
function imageUrls(html) {
  const out = [];
  let el = 0;
  for (const m of html.matchAll(/<(img|source)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const isImg = m[1].toLowerCase() === 'img';
    const attrs = m[2];
    const cors = hasAttr(attrs, 'crossorigin');
    el++;
    const src = isImg ? attrValue(attrs, 'src') : null;
    if (src) out.push({ url: src, cors, el });
    const srcset = attrValue(attrs, 'srcset');
    if (srcset) for (const url of srcsetUrls(srcset)) out.push({ url, cors, el });
  }
  for (const m of html.matchAll(/background(?:-image)?\s*:[^;"'}]*?url\(\s*(["'`]?)([^"'`)]+)\1\s*\)/gi)) {
    out.push({ url: m[2], cors: false, el: ++el });
  }
  return out.filter(({ url }) => url && !url.startsWith('data:') && !url.startsWith('blob:'));
}

function reportPreconnect(hosts, pagesJudged, reporter) {
  const imageHosts = [...hosts.entries()].filter(([, v]) => v.maxImages > 0);
  if (pagesJudged === 0) {
    reporter.skip(SEC, 'preconnect', 'no built page declares a canonical URL and astro.config sets no site — cannot tell which hosts are cross-origin');
    return;
  }
  if (imageHosts.length === 0) {
    reporter.pass(SEC, 'preconnect', `every image on the ${pagesJudged} built page(s) is same-origin — no connection to open early`);
    return;
  }

  // Judged per page, not per site: a host is missing its preconnect if ANY page
  // that loads images from it does not declare one.
  const missing = imageHosts.filter(([, v]) => v.missingOn.length > 0);
  // A host serving a single incidental image (one avatar, one badge) is not
  // what cost tasmanvisa 900 ms of LCP; advising it is right, failing a build
  // over it is not. Counted in ELEMENTS — a Set of URLs counted every srcset
  // rung and turned one avatar into three images.
  const heavy = missing.filter(([, v]) => v.maxImages >= 2);
  const incidental = missing.filter(([, v]) => v.maxImages === 1);

  // Prescribe the form that matches how the images are actually fetched.
  const linkFor = (origin, v) => `<link rel="preconnect" href="${origin}"${v.cors && !v.noCors ? ' crossorigin' : ''}>`;
  const where = (v) => (v.missingOn.length > 1 ? ` on ${v.missingOn.length} page(s), e.g. ${v.missingOn[0]}` : ` on ${v.missingOn[0]}`);
  for (const [origin, v] of heavy) {
    reporter.fix(SEC, 'preconnect', `${v.maxImages} images load from ${origin} with no <link rel="preconnect">${where(v)} — DNS + TLS only start when the parser reaches the first one`, `add ${linkFor(origin, v)} to <head>`, { file: v.missingOn[0] });
  }
  for (const [origin, v] of incidental) {
    reporter.suggest(SEC, 'preconnect', `1 image loads from ${origin} with no <link rel="preconnect">${where(v)}`, `add ${linkFor(origin, v)} to <head> if it is on the critical path`, { file: v.missingOn[0] });
  }
  if (missing.length === 0) {
    reporter.pass(SEC, 'preconnect', `all ${imageHosts.length} cross-origin image host(s) are preconnected on every page that uses them (${imageHosts.map(([o]) => o).join(', ')})`);
  }

  // The trap is a preconnect whose CORS mode does not MATCH the images'. A
  // browser pools connections by credentials mode: a plain <img> is a no-cors,
  // credentialed fetch, and a `crossorigin` preconnect opens an anonymous CORS
  // connection it cannot reuse, so a second one is opened and the hint bought
  // nothing. The reverse is just as dead — <img crossorigin> with a bare
  // preconnect. Until 2026-09-02 this check demanded `crossorigin` on every
  // image-host preconnect, which is right for fonts and fetch() and wrong for
  // the plain <img> that is nearly every image on a content site; MDN's own
  // preconnect example for a generic origin is bare, and the rule it states is
  // "match the resource's CORS and credentials mode".
  //
  // A hint is useful if SOMETHING can reuse it, so a mismatch is only reported
  // when the declared mode matches no image on the host. A single
  // `<img crossorigin>` among twenty plain ones used to flip one global flag and
  // make the correct bare preconnect a required finding — advice that would have
  // broken the other twenty fetches.
  const declared = imageHosts.filter(([, v]) => v.declared.size > 0);
  if (declared.length === 0) {
    reporter.skip(SEC, 'preconnect:crossorigin', `no preconnect declared to a cross-origin image host — nothing to match against`);
    return;
  }
  const mismatched = [];
  for (const [origin, v] of declared) {
    for (const [mode, page] of v.declared) {
      const reusable = mode === 'crossorigin' ? v.cors : v.noCors;
      if (!reusable) mismatched.push([origin, v, mode, page]);
    }
  }
  if (mismatched.length === 0) {
    reporter.pass(SEC, 'preconnect:crossorigin', `every preconnect to an image host matches its images' CORS mode`);
  }
  for (const [origin, v, mode, page] of mismatched) {
    if (mode === 'bare') {
      reporter.fix(SEC, 'preconnect:crossorigin', `<link rel="preconnect" href="${origin}"> has no crossorigin, but every image it serves is fetched with crossorigin — the connection it opens is not the one they reuse`, `write it as <link rel="preconnect" href="${origin}" crossorigin>`, { file: page });
    } else {
      reporter.fix(SEC, 'preconnect:crossorigin', `<link rel="preconnect" href="${origin}" crossorigin> opens an anonymous CORS connection, but every image it serves is a plain <img> (no-cors, credentialed) and cannot reuse it`, `drop the crossorigin attribute: <link rel="preconnect" href="${origin}"> — add it only if the <img> tags carry crossorigin too`, { file: page });
    }
  }
}

/**
 * A head `<link rel="preload" as="image">` has to match the `<img>` it is for,
 * byte for byte. If `imagesrcset`/`imagesizes` differ from the tag's
 * `srcset`/`sizes`, the browser resolves two different candidates and downloads
 * the image twice — the preload makes the page slower than none at all.
 */
function collectPreloadMismatches(head, html, page, out, seen) {
  for (const m of head.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = m[1];
    if (!/(?:^|\s)preload(?:\s|$)/i.test(attrValue(attrs, 'rel') ?? '')) continue;
    if ((attrValue(attrs, 'as') ?? '').toLowerCase() !== 'image') continue;
    seen.count++;
    const imagesrcset = attrValue(attrs, 'imagesrcset');
    const href = attrValue(attrs, 'href');
    const imagesizes = attrValue(attrs, 'imagesizes');

    // Find the <img> this preload is for: the one sharing a URL with it. No
    // match means the image is injected at runtime or lives on another page —
    // not something a static read can call a defect.
    const wanted = new Set([...(imagesrcset ? srcsetUrls(imagesrcset) : []), ...(href ? [href] : [])]);
    for (const tag of html.matchAll(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      const srcset = attrValue(tag[1], 'srcset');
      const src = attrValue(tag[1], 'src');
      const keys = new Set([...(srcset ? srcsetUrls(srcset) : []), ...(src ? [src] : [])]);
      if (![...keys].some((k) => wanted.has(k))) continue;

      const sizes = attrValue(tag[1], 'sizes');
      const srcsetDiffers = imagesrcset != null && srcset != null && norm(imagesrcset) !== norm(srcset);
      const sizesDiffers = imagesizes != null && sizes != null && norm(imagesizes) !== norm(sizes);
      if (srcsetDiffers || sizesDiffers) {
        const which = [srcsetDiffers ? 'imagesrcset ≠ srcset' : null, sizesDiffers ? 'imagesizes ≠ sizes' : null].filter(Boolean).join(' and ');
        out.push({ page, which, preload: truncate(imagesrcset ?? href ?? '', 70), tag: truncate(srcset ?? src ?? '', 70) });
      }
      break;
    }
  }
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function reportPreloadPairs(issues, preloads, reporter) {
  // Silence used to cover both outcomes: a build with no image preloads and a
  // build whose preloads all match printed nothing, so the rule was absent from
  // the report either way and a reader could not tell it had run.
  if (preloads === 0) {
    reporter.skip(SEC, 'preload:pair', 'no <link rel="preload" as="image"> in any built page — nothing to pair against an <img>');
    return;
  }
  if (issues.length === 0) {
    reporter.pass(SEC, 'preload:pair', `${preloads} image preload(s), each matching the <img> it preloads`);
    return;
  }
  for (const i of issues) {
    reporter.fix(SEC, 'preload:pair', `preload as="image" does not match the <img> it preloads (${i.which}) — the browser resolves two candidates and downloads the image twice`, 'make the preload\'s imagesrcset/imagesizes byte-identical to the tag\'s srcset/sizes', { file: i.page });
  }
}

function distTree(dir) {
  const out = [];
  for (const full of walkFiles(dir, { skip: (n) => n.startsWith('.') || SKIP_DIST.has(n) })) out.push(full);
  return out;
}

function sizeOf(p) {
  try { return statSync(p).size; } catch { return 0; }
}

function humanKB(bytes) {
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}
