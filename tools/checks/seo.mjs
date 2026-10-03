// seo — the discoverability surface: a canonical SEO component emitting
// canonical URL, OG meta, and the brand fields they need.
// (Structured data / JSON-LD / llms.txt live in the data check.)

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { eachDistHtml, isContentPage, headingOutline, headingAudit, attrValue, blankScripts } from '../lib/html.mjs';
import { readSrcFiles, headMetaFiles, stripComments } from '../lib/src-scan.mjs';
import { distDir, distFiles, readDist, sitemapPages, sitemapPageFiles, sitemapEntries, decodePath, distRelative } from '../lib/dist.mjs';
import { editFile } from '../lib/remedy.mjs';
import { truncate } from '../lib/text.mjs';
import { imageSize } from '../lib/image-size.mjs';

const SEC = 'seo';

// A tag counts as emitted only when it appears as a real attribute —
// `property="og:image"`, never the bare word. Matching bare substrings meant a
// line of prose satisfied the check: a component containing nothing but
// `// TODO: emit og:image, og:type and rel="canonical"` passed six checks at
// once. Comments are blanked before matching too (see lib/src-scan.mjs), so
// both halves of that failure are closed.
const metaRe = (key) => new RegExp(`(?:property|name)\\s*=\\s*["']${key}["']`, 'i');
// The shipped-HTML twin: the tag must also carry a non-empty `content`. In
// source, `content={description}` is the correct and only possible spelling, so
// presence is all that can be asked there — but a built page whose meta
// description rendered as `content=""` has the tag and none of the value, and
// reading that as ✅ is how an empty <title> shipped on every page of a site
// while the audit said the head surface was complete. Lookaheads rather than a
// fixed attribute order: `<meta content="…" name="description">` is equally
// valid HTML and Astro's compressHTML has reordered attributes before.
// The closing quote is part of the pattern, and that is the whole subtlety:
// `content=""` against `content\\s*=\\s*["'][^"']*\\S` MATCHES, because `\\S` is
// happy to be the closing quote itself. An empty description read as ✅ until
// the value had to be bounded on both sides.
// A FUNCTION, not a regex, and that is the whole point. The lookahead version
// bounded the value on both sides — `content=""` no longer satisfied `\S` by
// letting it be the closing quote — but the alternative it backtracked into
// could leave the tag entirely: `"[^"]*\S[^"]*"` matches across a `>` to the
// next quote anywhere in the document, so
//
//     <meta name="description" content=""><link rel="canonical" href="/">
//
// read as a FILLED description, because the value ran from the empty pair to
// the quote in the <link>. An empty description reported as ✅ is precisely the
// silent false negative this file's own comment says it fixed. It only stayed
// hidden because the test put the empty tag last, where no later quote exists.
//
// Scanning real tags and reading the attribute out of one is not a
// cleverer regex; it removes the class.
const metaFilled = (key) => (html) => hasFilledMeta(html, key);

// `<meta …>` with an unambiguous attribute scan — see lib/html.mjs on why the
// alternation must not let `[^>]` also match a quote.
const META_TAG_RE = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

function hasFilledMeta(html, key) {
  META_TAG_RE.lastIndex = 0;
  for (const m of String(html ?? '').matchAll(META_TAG_RE)) {
    const name = attrValue(m[1], 'property') ?? attrValue(m[1], 'name');
    if (!name || name.toLowerCase() !== key.toLowerCase()) continue;
    if ((attrValue(m[1], 'content') ?? '').trim()) return true;
  }
  return false;
}
const CANONICAL_RE = /rel\s*=\s*["']canonical["']/i;
// [name, source matcher, built-HTML matcher, severity when absent].
//
// og:image:width/height are a layout hint — a card renders fine without them,
// platforms just can't reserve space before fetching it. Two well-built dogfood
// sites had exactly these two as their ONLY required finding, which is the
// signal that the severity was wrong rather than the sites.
//
// title/description/og:title were live-only until 2026-09-04, which meant the
// DEFAULT (offline) audit never checked them at all: a site could ship every
// page with an empty <title> and no description, pass `seo` clean, and hear
// about it only from whoever remembered to pass --url. They are the three tags
// a search result is literally made of, so they are judged over the same
// sitemap denominator as the rest.
const META_TAGS = [
  ['title',           /<title[\s>]/i,           /<title>[^<]*\S[^<]*<\/title>/i, 'fix'],
  ['description',     metaRe('description'),    metaFilled('description'),      'fix'],
  ['og:title',        metaRe('og:title'),       metaFilled('og:title'),         'fix'],
  ['og:image',        metaRe('og:image'),       null,                           'fix'],
  ['og:image:width',  metaRe('og:image:width'), null,                           'suggest'],
  ['og:image:height', metaRe('og:image:height'),null,                           'suggest'],
  ['og:type',         metaRe('og:type'),        null,                           'fix'],
  ['og:url',          metaRe('og:url'),         null,                           'fix'],
  ['canonical',       CANONICAL_RE,             null,                           'fix'],
];

export async function run({ project, reporter }) {
  // The head-meta surface, found by behaviour rather than filename. A site may
  // put this in SEO.astro, BaseHead.astro, or straight into a layout — all are
  // correct, so search every source file and report against the union.
  const srcFiles = readSrcFiles(project.root);
  const headFiles = headMetaFiles(srcFiles);
  const head = headFiles.map((f) => f.code).join('\n');

  if (headFiles.length === 0) {
    reporter.fix(SEC, 'SEO component', 'no source file emits head metadata (canonical, OG tags or <title>)', 'add an SEO/head component that every page renders in <head>');
  } else {
    reporter.pass(SEC, 'SEO component', headFiles.map((f) => f.path).join(', '));
  }

  // Individual tags run whether or not a dedicated component exists — an absent
  // component must not silently skip them.
  checkMetaTags(project, reporter, head, headFiles.map((f) => f.path));

  // Anti-pattern: <meta name="keywords"> (ignored by search engines, signals spam)
  const kw = srcFiles.find((f) => /name=["']keywords["']/.test(f.code));
  if (kw) {
    // Deleting a tag is the rare fix with exactly one right answer: there is no
    // correct <meta name="keywords">, so there is nothing to decide. The tag is
    // taken from the comment-blanked source, which is what matched — a keywords
    // meta inside a comment is not a finding and must not be edited either.
    const tag = kw.code.match(/<meta[^>]*name=["']keywords["'][^>]*>/i)?.[0];
    reporter.fix(SEC, 'no-keywords', `<meta name="keywords"> in ${kw.path} (anti-pattern)`, 'remove the keywords meta',
      tag ? { file: kw.path, remedy: editFile(kw.path, tag, '') } : { file: kw.path });
  }
  else    reporter.pass(SEC, 'no-keywords', `not emitted by any of the ${srcFiles.length} source file(s) under src/`);

  // Brand fields (only checkable when scripts/og.config.mjs declares them)
  const brand = project.ogConfig?.brand ?? project.ogConfig;
  if (brand) {
    const required = ['siteName', 'siteUrl', 'tagline'];
    for (const k of required) {
      // The value, not a bare tick: these render straight into head meta, so
      // "set" and "set to something sensible" are different verdicts and only
      // the reader can tell them apart.
      if (brand[k]) reporter.pass(SEC, `brand.${k}`, truncate(String(brand[k]), 60));
      else          reporter.fix(SEC, `brand.${k}`, 'missing (used by SEO meta)', `set brand.${k} in scripts/og.config.mjs`);
    }
    const optional = ['authorName', 'authorUrl', 'twitterSite', 'twitterCreator'];
    const missing = optional.filter((k) => !brand[k]);
    if (missing.length) reporter.suggest(SEC, 'brand:optional', `missing: ${missing.join(', ')}`, 'set for richer SEO/social cards (optional)');
    else reporter.pass(SEC, 'brand:optional', `all set: ${optional.join(', ')}`);
  }

  checkRobots(project, reporter);
  checkRobotsScope(project, reporter);
  checkFavicon(project, reporter);
  checkSitemap(project, reporter);
  checkHreflang(project, reporter);
  checkBuiltPages(project, reporter);

  // Heading outline on built content pages: exactly one <h1>, no skipped levels.
  // Scoped to pages with a canonical link, so OG-template / preview routes (no
  // canonical) don't get flagged for legitimately having no <h1>.
  if (project.hasDist) checkHeadings(project, reporter, srcFiles);
}

/**
 * Are the head tags actually emitted? Assert against `dist/` when it exists —
 * that is the artifact that ships, and it contains no comments, no unreachable
 * branches and no aspirational TODOs. Source is the fallback for an unbuilt
 * project, and is matched comment-blanked.
 *
 * Coverage, not mere presence. "Emitted anywhere in the build" passed a site
 * that had a canonical on one page out of nineteen. Every tag is now judged
 * across the site's declared pages: all → pass, none → fix, some → suggest,
 * naming the pages that omit it.
 */
/** A META_TAGS matcher is either a RegExp (source text) or a tag-reading function. */
const matches = (m, html) => (typeof m === 'function' ? m(html) : m.test(html));

function checkMetaTags(project, reporter, headSrc, headFilePaths = []) {
  const all = [];
  if (project.hasDist) eachDistHtml(project.root, (rel, html) => all.push({ rel, html }));

  // The denominator is the sitemap when there is one — the site's own list of
  // what it publishes. Falling back to "every built page" counts OG templates
  // and preview routes; using "pages that have a canonical" made the canonical
  // check measure itself.
  const declared = project.hasDist ? sitemapPages(project.root) : null;
  const pages = declared
    ? all.filter((p) => declared.has(distRelative(project.root, p.rel)))
    : all;
  const denominator = declared ? 'sitemap page(s)' : 'built page(s)';

  // Name the file rather than "the component that renders <head>": the same run
  // already identified it, and making the reader go and find it again is work
  // the tool could have done.
  const where2 = headFilePaths.length ? ` (${headFilePaths.join(', ')})` : '';
  const emitFrom = `emit it from the component that renders <head>${where2}`;

  if (all.length === 0) {
    const where = project.hasDist ? 'dist/ has no HTML' : 'no dist/';
    for (const [name, re, , severity] of META_TAGS) {
      if (matches(re, headSrc)) reporter.pass(SEC, `meta:${name}`, `emitted in src/ (${where} — build to check the shipped HTML)`);
      else reporter[severity](SEC, `meta:${name}`, `tag not emitted anywhere in src/ (${where}, so source is all there is to read)`, emitFrom);
    }
    return;
  }

  const judged = pages.length ? pages : all;
  for (const [name, srcRe, distRe, severity] of META_TAGS) {
    const re = distRe ?? srcRe;
    const missing = judged.filter((p) => !matches(re, p.html));
    if (missing.length === judged.length) {
      reporter[severity](SEC, `meta:${name}`, `not emitted on any of the ${judged.length} ${denominator}`, emitFrom);
    } else if (missing.length === 0) {
      reporter.pass(SEC, `meta:${name}`, `on all ${judged.length} ${denominator}`);
    } else {
      // Partial coverage is the interesting case and used to be invisible: a
      // tag on one page out of nineteen read as ✅.
      reporter.suggest(SEC, `meta:${name}`, `${missing.length}/${judged.length} ${denominator} omit it — ${sampleOf(missing.map((p) => p.rel))}`, `emit ${name} on every published page, not just some`);
    }
  }

  checkCanonicalValues(reporter, judged, denominator);
}

/**
 * A canonical link is only doing its job if it differs per page.
 *
 * Presence alone passed a site where twenty pages all declared the same
 * canonical URL — which tells a crawler nineteen of them are duplicates of the
 * twentieth and should be dropped from the index. That is strictly worse than
 * having no canonical at all, and it read as ✅.
 *
 * Only a value covering MORE THAN HALF the pages is reported, and only as
 * advice. Sharing a canonical across a few pages is a legitimate, deliberate
 * thing to do — the bundled i18n fixture does it, because a locale fallback
 * rewrite serves the default locale's content and *is* a duplicate of it. A
 * site-wide constant is the failure; a handful of intentional duplicates is not.
 */
function checkCanonicalValues(reporter, pages, denominator) {
  const byValue = new Map();
  for (const p of pages) {
    const href = p.html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/)?.[1];
    if (!href) continue;
    if (!byValue.has(href)) byValue.set(href, []);
    byValue.get(href).push(p.rel);
  }
  if (byValue.size < 2 && pages.length < 2) return;   // nothing to compare
  // No page carries a canonical at all. `meta:canonical` reports that; what this
  // must not do is print "✅ 0 distinct canonical URL(s)" underneath it, which is
  // a green tick for a comparison that had nothing to compare — the pass-for-work-
  // never-done that CONTRIBUTING § "never let a check silently not run" forbids.
  if (byValue.size === 0) {
    reporter.skip(SEC, 'canonical:unique', `none of the ${pages.length} ${denominator} declares a canonical URL — nothing to compare (see seo: meta:canonical)`);
    return;
  }
  const worst = [...byValue.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (worst[1].length * 2 <= pages.length) {
    reporter.pass(SEC, 'canonical:unique', `${byValue.size} distinct canonical URL(s) across ${pages.length} ${denominator}`);
    return;
  }
  reporter.suggest(SEC, 'canonical:unique', `${worst[1].length} of ${pages.length} pages declare the SAME canonical URL (${worst[0]}) — that asks crawlers to drop ${worst[1].length - 1} of them as duplicates: ${sampleOf(worst[1])}`, "compute the canonical from each page's own URL rather than a site-wide constant (unless these really are deliberate duplicates, e.g. locale fallbacks)");
}

/**
 * robots.txt — the file, not the package that might have written it.
 *
 * This was `modules:dep:astro-robots-txt`: a required finding for anyone who
 * hadn't installed one specific integration. All five dogfood sites shipped a
 * correct robots.txt without it — three as a generated endpoint, which is
 * *better* than the package and would collide with it. What matters is that the
 * built site serves one and that it points crawlers at the sitemap.
 *
 * The `Sitemap:` value is checked as a URL, not as a non-empty string. The spec
 * requires an absolute one, and a relative `Sitemap: /sitemap-index.xml` is the
 * mistake that looks most correct — every other line in the file is a path.
 */
function checkRobots(project, reporter) {
  if (!project.hasDist) {
    reporter.skip(SEC, 'robots', 'no dist/ — build the site to check it serves a robots.txt with a Sitemap: line');
    return;
  }
  const text = readDist(project.root, 'robots.txt');
  if (!text.trim()) {
    // No third-party integration named here. Both platform primitives do the
    // job, and this tool does not send anyone shopping (BEST-PRACTICES.md,
    // "Own it before you buy it").
    reporter.fix(SEC, 'robots', 'dist/robots.txt is missing or empty', 'ship a robots.txt — a src/pages/robots.txt.ts endpoint that emits the Sitemap: line from `site`, or a static public/robots.txt', { file: 'dist/robots.txt' });
    return;
  }
  const line = text.match(/^\s*Sitemap:\s*(\S+)/im);
  if (!line) {
    reporter.fix(SEC, 'robots', 'dist/robots.txt has no Sitemap: line — crawlers are not pointed at the sitemap', 'add "Sitemap: https://<site>/sitemap-index.xml"', { file: 'dist/robots.txt' });
    return;
  }
  let target;
  try { target = new URL(line[1]); } catch {
    reporter.fix(SEC, 'robots', `dist/robots.txt declares a relative sitemap URL (Sitemap: ${line[1]}) — the spec requires an absolute one and crawlers discard this line`, 'write the full URL: "Sitemap: https://<site>/sitemap-index.xml"', { file: 'dist/robots.txt' });
    return;
  }
  // Does that URL actually exist in this build? On a static site dist/ IS the
  // served surface, so a Sitemap: line pointing at a file the build never wrote
  // is Search Console's "Sitemap could not be read" before anyone deploys. Only
  // advisory: the sitemap may legitimately be served from elsewhere, and the
  // origin here is whatever `site` was set to, which this tool cannot resolve.
  const wanted = decodePath(target.pathname).replace(/^\/+/, '');
  const built = distFiles(project.root, /sitemap[-a-z0-9]*\.xml$/i);
  if (wanted && built.length && !built.includes(wanted)) {
    reporter.suggest(SEC, 'robots', `dist/robots.txt points at /${wanted}, which this build did not write — it emitted ${built.join(', ')}`, `point the Sitemap: line at ${built.includes('sitemap-index.xml') ? '/sitemap-index.xml' : `/${built[0]}`} (@astrojs/sitemap writes an index plus numbered parts, not /sitemap.xml)`, { file: 'dist/robots.txt' });
    return;
  }
  reporter.pass(SEC, 'robots', `served with a Sitemap: line → ${line[1]}`, { file: 'dist/robots.txt' });
}

// Every sitemap rule, so that "no dist/" skips them by name instead of leaving
// them silently unrun — CONTRIBUTING.md, "never let a check silently not run".
const SITEMAP_RULES = ['sitemap:urls', 'sitemap:lastmod', 'sitemap:hints', 'sitemap:noindex', 'sitemap:blocked', 'sitemap:canonical'];

function skipAll(reporter, names, why) {
  for (const n of names) reporter.skip(SEC, n, why);
}

/**
 * The sitemap, judged against what Google actually does with it.
 *
 * Verified against Google's "Build and submit a sitemap" (2026-09-04) rather
 * than from memory, because two of the four things people tune in a sitemap are
 * read by nobody: `<changefreq>` and `<priority>` are documented as ignored, and
 * a site that sets them is maintaining a fiction. What is left that matters is
 * small and checkable: absolute URLs, the size caps, and a `<lastmod>` that
 * parses.
 */
function checkSitemap(project, reporter) {
  if (!project.hasDist) {
    skipAll(reporter, SITEMAP_RULES, 'no dist/ — build the site to read the sitemap it ships');
    return;
  }
  const { entries, sizes } = sitemapEntries(project.root);
  if (entries.length === 0) {
    reporter.fix(SEC, 'sitemap:lastmod', 'no sitemap with <url> entries in dist/', 'add @astrojs/sitemap (or an endpoint that emits one) so search engines get a full URL list');
    skipAll(reporter, SITEMAP_RULES.filter((n) => n !== 'sitemap:lastmod'), 'no sitemap with <url> entries in dist/ — nothing to read');
    return;
  }
  // Only the files that actually carried <url> entries. A sitemap INDEX lists
  // other sitemaps and contributes none, so naming it as the source of "43/43
  // entries" is a small lie in every message that follows.
  const where = [...new Set(entries.map((e) => e.file))].join(', ');

  checkSitemapUrls(reporter, entries, sizes, where);
  checkSitemapLastmod(reporter, entries, where);
  checkSitemapHints(reporter, entries, where);
  checkSitemapPages(project, reporter, entries);
}

/**
 * Structure: absolute URLs, one origin, inside Google's caps.
 *
 * 50,000 URLs and 50 MB uncompressed per file are hard limits — over either and
 * the file is rejected whole, so a site that grew past one loses its entire
 * sitemap rather than the overflow. @astrojs/sitemap splits at `entryLimit`
 * (45,000 by default), which is why this is a cheap check that almost never
 * fires and is worth having anyway: it fires on the sites that hand-rolled an
 * endpoint instead.
 */
function checkSitemapUrls(reporter, entries, sizes, where) {
  const relative = entries.filter((e) => !/^[a-z][a-z0-9+.-]*:/i.test(e.loc));
  if (relative.length) {
    reporter.fix(SEC, 'sitemap:urls', `${relative.length}/${entries.length} <loc> values are not absolute URLs — ${sampleOf(relative.map((e) => e.loc))}`, 'emit fully-qualified URLs (https://host/path); set `site` in astro.config so @astrojs/sitemap can build them');
    return;
  }
  const MAX_URLS = 50000, MAX_BYTES = 50 * 1024 * 1024;
  const perFile = new Map();
  for (const e of entries) perFile.set(e.file, (perFile.get(e.file) ?? 0) + 1);
  const over = [...perFile].filter(([, n]) => n > MAX_URLS);
  if (over.length) {
    reporter.fix(SEC, 'sitemap:urls', `${over.map(([f, n]) => `${f} has ${n} URLs`).join('; ')} — over Google's 50,000 limit, so the file is rejected whole`, 'split it: @astrojs/sitemap does this automatically via entryLimit, and writes a sitemap index');
    return;
  }
  const heavy = [...sizes].filter(([, n]) => n > MAX_BYTES);
  if (heavy.length) {
    reporter.fix(SEC, 'sitemap:urls', `${heavy.map(([f, n]) => `${f} is ${(n / 1048576).toFixed(1)} MB`).join('; ')} uncompressed — over Google's 50 MB limit`, 'lower entryLimit so @astrojs/sitemap writes more, smaller files');
    return;
  }
  // Cross-domain URLs are legal once both properties are verified in Search
  // Console, so this is advice rather than a finding — but it is far more often
  // a stale `site` value than a deliberate cross-post.
  const origins = new Set(entries.map((e) => originOf(e.loc)).filter(Boolean));
  if (origins.size > 1) {
    reporter.suggest(SEC, 'sitemap:urls', `${entries.length} URLs span ${origins.size} origins (${[...origins].join(', ')})`, 'a sitemap covering more than one origin only works when every one of them is verified in Search Console — if that was not deliberate, check `site` in astro.config');
    return;
  }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  reporter.pass(SEC, 'sitemap:urls', `${entries.length} absolute URL(s) on ${[...origins][0] ?? 'one origin'}, ${(total / 1024).toFixed(0)} KB (${where})`);
}

/**
 * <lastmod>, counted only where it parses.
 *
 * Google reads lastmod "if it's consistently and verifiably accurate", and the
 * value has to be a W3C datetime — `March 3, 2026` is not a date to a parser,
 * it is a string that gets the whole element ignored. So a malformed lastmod is
 * counted as the absence it effectively is, rather than as a separate finding:
 * making it its own 🔧 while a *missing* lastmod stays 💡 would tell a site it
 * is better off deleting the element than fixing it.
 */
function checkSitemapLastmod(reporter, entries, where) {
  const present = entries.filter((e) => e.lastmod);
  const invalid = present.filter((e) => !W3C_DATETIME.test(e.lastmod));
  const valid = present.length - invalid.length;
  const badNote = invalid.length
    ? ` — ${invalid.length} value(s) are not W3C datetime and are ignored (${sampleOf(invalid.map((e) => e.lastmod))})`
    : '';

  if (valid >= entries.length) {
    reporter.pass(SEC, 'sitemap:lastmod', `${valid}/${entries.length} entries carry a valid <lastmod> (${where})`);
    return;
  }
  reporter.suggest(SEC, 'sitemap:lastmod', `${valid}/${entries.length} sitemap entries carry a valid <lastmod> (${where})${badNote}`, "set item.lastmod in @astrojs/sitemap's serialize(item) hook, from whichever date field your own frontmatter uses, as an ISO 8601 string (new Date(d).toISOString()). If you already have a serialize(), it is not reaching these URLs — the callback receives only { url, changefreq, lastmod, priority, links }, so a per-page date has to be looked up by URL");
}

/** W3C datetime, the format the sitemap spec names: a date, optionally a time. */
const W3C_DATETIME = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

/**
 * <changefreq> and <priority>: bytes Google throws away.
 *
 * Both are in the sitemap spec and both are documented as ignored, which makes
 * them the one thing in a sitemap that is purely cost — and the one people most
 * often hand-tune, because a `priority` of 1.0 on the homepage feels like it
 * must be doing something. Advisory by construction: shipping them is not a
 * defect, it is just work that buys nothing.
 */
function checkSitemapHints(reporter, entries, where) {
  const cf = entries.filter((e) => e.changefreq).length;
  const pr = entries.filter((e) => e.priority).length;
  if (!cf && !pr) {
    reporter.pass(SEC, 'sitemap:hints', `no <changefreq>/<priority> (${where}) — Google ignores both`);
    return;
  }
  const parts = [cf && `${cf} <changefreq>`, pr && `${pr} <priority>`].filter(Boolean);
  reporter.suggest(SEC, 'sitemap:hints', `${parts.join(' and ')} in ${where} — Google's sitemap documentation lists both as ignored`, 'drop the changefreq/priority options from the sitemap config; <lastmod> is the only hint that is read');
}

/**
 * The sitemap against the pages it declares — three contradictions.
 *
 * A sitemap is a request to index every URL in it, so the interesting failures
 * are the ones where the site says the opposite somewhere else. All three are
 * named errors in Search Console, and none is visible from either half alone:
 *
 * - `noindex` on a submitted URL ("Submitted URL marked 'noindex'"). Usually a
 *   staging value that survived, and the highest-consequence SEO defect there
 *   is — the page is asking to be dropped from the index while the sitemap asks
 *   for it to be added.
 * - blocked by robots.txt: the crawler is told to fetch it and told not to.
 * - a canonical pointing elsewhere: the URL is submitted and then disclaimed by
 *   the page it resolves to.
 */
function checkSitemapPages(project, reporter, entries) {
  const files = sitemapPageFiles(project.root);
  if (files.size === 0) {
    skipAll(reporter, ['sitemap:noindex', 'sitemap:blocked', 'sitemap:canonical'], `none of the ${entries.length} sitemap URL(s) resolves to a built page — nothing to cross-check`);
    return;
  }
  const robots = readDist(project.root, 'robots.txt');
  const disallow = robotsRules(robots);
  const byLoc = new Map(entries.map((e) => [e.loc, e]));

  const noindex = [], blocked = [], mismatch = [], slashOnly = [];
  for (const [loc, file] of files) {
    const html = readDist(project.root, file);
    if (NOINDEX_RE.test(html)) noindex.push(`${file} (${loc})`);

    let path;
    try { path = decodePath(new URL(loc).pathname) || '/'; } catch { path = null; }
    if (path && disallow.length && isBlocked(disallow, path)) blocked.push(`${loc} (matched ${isBlocked(disallow, path)})`);

    const declared = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/)?.[1];
    if (!declared) continue;
    const a = normalizeUrl(declared), b = normalizeUrl(loc);
    if (!a || !b || (a.origin === b.origin && a.path === b.path)) continue;
    // A localized entry legitimately points at a shared canonical: the fallback
    // rewrite at /hu/design serves the English page and correctly canonicalises
    // to /design. The sitemap says so itself — that URL is in the entry's own
    // <xhtml:link> alternates — so consolidation that the sitemap already
    // declares is not a contradiction. Without this the bundled i18n fixture,
    // which is correct, collected two required findings.
    const alt = (byLoc.get(loc)?.alternates ?? []).some((h) => {
      const n = normalizeUrl(h);
      return n && n.origin === a.origin && n.path === a.path;
    });
    if (alt) continue;
    (a.origin === b.origin && a.path.replace(/\/$/, '') === b.path.replace(/\/$/, '') ? slashOnly : mismatch)
      .push(`${loc} → canonical ${declared}`);
  }

  if (noindex.length) reporter.fix(SEC, 'sitemap:noindex', `${noindex.length}/${files.size} sitemap page(s) carry a noindex robots meta — ${sampleOf(noindex)}`, 'a page cannot be submitted and withheld at once: drop the noindex, or exclude the page from the sitemap (@astrojs/sitemap filter)');
  else reporter.pass(SEC, 'sitemap:noindex', `none of the ${files.size} sitemap page(s) carries a noindex robots meta`);

  if (!disallow.length) reporter.pass(SEC, 'sitemap:blocked', `robots.txt disallows nothing for *, so no sitemap URL can be blocked by it`);
  else if (blocked.length) reporter.fix(SEC, 'sitemap:blocked', `${blocked.length}/${files.size} sitemap page(s) are Disallow'd in robots.txt — ${sampleOf(blocked)}`, "the sitemap asks for these to be crawled and robots.txt forbids it: exclude them from the sitemap (@astrojs/sitemap filter) or drop the Disallow");
  else reporter.pass(SEC, 'sitemap:blocked', `no sitemap page matches a robots.txt Disallow (${disallow.length} rule(s) for *)`);

  if (mismatch.length) reporter.fix(SEC, 'sitemap:canonical', `${mismatch.length}/${files.size} sitemap page(s) declare a different canonical — ${sampleOf(mismatch)}`, 'a sitemap should list canonical URLs only: either list the canonical instead, or drop the page from the sitemap');
  else if (slashOnly.length) reporter.suggest(SEC, 'sitemap:canonical', `${slashOnly.length}/${files.size} sitemap page(s) differ from their canonical only by a trailing slash — ${sampleOf(slashOnly)}`, 'these are two URLs to a crawler: make `site`, trailingSlash and the canonical agree');
  else reporter.pass(SEC, 'sitemap:canonical', `all ${files.size} resolvable sitemap page(s) declare themselves canonical`);
}

// `noindex` from either the generic robots meta or googlebot's. Matched on the
// tag, not the bare word, so the string "noindex" in a paragraph is not a
// finding — the built page is where prose lives.
const NOINDEX_RE = /<meta(?=[^>]*\bname\s*=\s*["'](?:robots|googlebot)["'])(?=[^>]*\bcontent\s*=\s*["'][^"']*\bnoindex\b)[^>]*>/i;

/**
 * The Disallow/Allow rules that apply to `*`, in declaration order.
 *
 * Both are collected because Disallow alone gets the answer wrong: the standard
 * resolves a path by the LONGEST matching rule, with Allow winning a tie, so a
 * site with `Disallow: /blog` and `Allow: /blog/public/` is not blocking
 * /blog/public/ — and reporting that it does would be a finding against a
 * correct file. A group ends at the next User-agent line that follows a rule.
 */
function robotsRules(text) {
  const rules = [];
  let agents = [], afterRule = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const ua = line.match(/^User-agent\s*:\s*(\S+)/i);
    if (ua) {
      if (afterRule) { agents = []; afterRule = false; }
      agents.push(ua[1]);
      continue;
    }
    const rule = line.match(/^(Allow|Disallow)\s*:\s*(\S*)/i);
    if (!rule) continue;
    afterRule = true;
    if (!agents.includes('*') || !rule[2]) continue;   // empty Disallow: means "allow everything"
    rules.push({ allow: /^allow$/i.test(rule[1]), path: rule[2] });
  }
  return rules;
}

/**
 * The blocking rule's path, or null. Longest rule path wins; Allow wins a tie.
 *
 * The length is the RULE PATH's, wildcards counted — Google's spec is explicit
 * ("crawlers use the most specific rule based on the length of the rule path")
 * and its own worked example settles the case this used to get backwards:
 *
 *     Allow: /page   Disallow: /*.htm   on  /page.htm   →  DISALLOWED,
 *     "because the rule path is longer and it matches more characters".
 *
 * This measured `'/*.htm'.replace(/\*​/g,'')` = 5 against `'/page'` = 5, hit the
 * Allow-wins-a-tie branch and reported the URL as crawlable. A sitemap listing
 * it then passed `sitemap:blocked` while every real crawler refused the page.
 * Verified against developers.google.com/search/docs/crawling-indexing/robots/robots_txt
 * on 2026-09-06.
 */
function isBlocked(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!robotsMatch(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { ...r, len };
  }
  return best && !best.allow ? best.path : null;
}

// robots.txt pattern matching: `*` is any run of characters, `$` anchors the
// end, everything else is a literal prefix.
function robotsMatch(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** Origin + path, with the root's empty path spelled `/`. */
function normalizeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  return { origin: u.origin, path: decodePath(u.pathname) || '/' };
}

/**
 * hreflang alternates on a multi-locale site.
 *
 * Only runs when the config declares two or more locales — on a single-language
 * site there is nothing to alternate between, and firing there would be the one
 * thing a check must never do. Either carrier counts: @astrojs/sitemap's `i18n`
 * option writes <xhtml:link rel="alternate"> into the sitemap, and a per-page
 * <link rel="alternate" hreflang> in the document head says the same thing.
 * Without one of them, each locale competes with its own translations.
 */
function checkHreflang(project, reporter) {
  // Comment-blanked: `// consider i18n later, e.g. locales: ['en', 'hu']` beside
  // a single-locale config used to make hreflang required on a site that has
  // nothing to alternate between — a finding against a compliant site, which is
  // the one thing a check must never produce. modules.mjs already strips the
  // same file before scanning it.
  const locales = declaredLocales(stripComments(project.astroConfig ?? ''));
  if (locales.size < 2) {
    reporter.skip(SEC, 'hreflang', `astro.config declares ${locales.size === 1 ? 'a single locale' : 'no locales'} — a single-language site has no alternates to declare`);
    return;
  }
  if (!project.hasDist) {
    reporter.skip(SEC, 'hreflang', `${locales.size} locales declared, but no dist/ — build the site to check it emits alternates`);
    return;
  }
  const inSitemap = sitemapEntries(project.root).entries.filter((e) => e.alternates.length).length;
  if (inSitemap) {
    reporter.pass(SEC, 'hreflang', `${inSitemap} sitemap entries carry <xhtml:link rel="alternate"> for ${locales.size} locales`);
    return;
  }
  let pages = 0;
  eachDistHtml(project.root, (rel, html) => { if (HREFLANG_RE.test(html)) pages++; });
  if (pages) reporter.pass(SEC, 'hreflang', `${pages} built page(s) carry <link rel="alternate" hreflang> for ${locales.size} locales`);
  else reporter.fix(SEC, 'hreflang', `${locales.size} locales declared (${[...locales].join(', ')}) but no hreflang alternates in the sitemap or any built page`, 'pass the i18n option to @astrojs/sitemap ({ defaultLocale, locales }) so every entry lists its translations, or emit <link rel="alternate" hreflang> from the head component');
}

const HREFLANG_RE = /<link[^>]+rel=["']alternate["'][^>]*\bhreflang\s*=/i;

/**
 * The locale codes any `locales:` block in astro.config names.
 *
 * Read from config TEXT (the config is never executed — lib/project.mjs has the
 * why), and deliberately not scoped to Astro's own `i18n` block: the sitemap
 * integration takes a `locales` map of its own, and either one appearing with
 * two or more codes means the same thing for this check. Both spellings are
 * covered — `['en','hu']` and `{ en: 'en-US', hu: 'hu-HU' }`.
 */
function declaredLocales(configText) {
  const text = String(configText ?? '');
  const out = new Set();
  for (const m of text.matchAll(/\blocales\s*:\s*([[{])/g)) {
    const open = m[1], close = open === '[' ? ']' : '}';
    let depth = 0, end = -1;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    for (const q of text.slice(m.index, end).matchAll(/['"`]([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)['"`]/gi)) {
      out.add(q[1].toLowerCase().split('-')[0]);
    }
  }
  return out;
}

function checkHeadings(project, reporter, srcFiles) {
  const h1bad = [], skipbad = [];
  let pages = 0;
  eachDistHtml(project.root, (rel, html) => {
    if (!isContentPage(html)) return;
    pages++;
    const outline = headingOutline(html);
    const a = headingAudit(outline.map((h) => h.level));
    if (a.h1) h1bad.push(`${rel} (${a.h1})`);
    if (a.skip) {
      // The built page is where it showed up; the component is where it was
      // written, and that is what someone has to edit.
      const offender = outline[a.skipAt];
      const source = offender ? traceHeadingToSource(srcFiles, offender) : null;
      skipbad.push(source
        ? `${source} (${a.skip}, at "${truncate(offender.text, 40)}") — via ${rel}`
        : `${rel} (${a.skip}${offender?.text ? `, at "${truncate(offender.text, 40)}"` : ''})`);
    }
  });

  if (pages === 0) {
    reporter.skip(SEC, 'headings', 'no built content pages (with canonical) in dist/ — nothing to check');
    return;
  }

  // Exactly one <h1> — required.
  if (h1bad.length === 0) {
    reporter.pass(SEC, 'headings:h1', `${pages} content page(s) have exactly one <h1>`);
  } else {
    reporter.fix(SEC, 'headings:h1', `${h1bad.length}/${pages} content page(s) — ${sampleOf(h1bad)}`, 'exactly one <h1> per page (the page title)');
  }

  // No skipped levels — advisory (often a shared header/footer heading level).
  if (skipbad.length === 0) {
    reporter.pass(SEC, 'headings:order', 'no skipped heading levels');
  } else {
    reporter.suggest(SEC, 'headings:order', `${skipbad.length}/${pages} content page(s) skip a heading level — ${sampleOf(skipbad)}`, 'keep the outline sequential (h2→h3→h4); a shared header/footer using a deeper level is the usual cause');
  }
}

/**
 * The source file and line that emitted a built heading, or null.
 *
 * `null` is the common and correct answer: a heading rendered from frontmatter
 * (`<h2>{title}</h2>`) has no literal text to find. A confidently wrong pointer
 * is worse than the artifact path, so this returns a location only when
 * **exactly one** source matches — several matches, or none, and the caller
 * keeps reporting the built page.
 */
function traceHeadingToSource(srcFiles, { level, text }) {
  if (!text || text.length < 4) return null;
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The tag, then any inline wrappers (a link, an anchor icon), then the text.
  const tag = new RegExp(`<h${level}\\b[^>]*>\\s*(?:<[^>]+>\\s*)*${escaped}`, 'i');
  // …or the markdown that compiles to it.
  const md = new RegExp(`^\\s{0,3}#{${level}}\\s+${escaped}\\s*$`, 'im');

  const hits = [];
  for (const f of srcFiles) {
    const body = f.code ?? f.text;
    const m = tag.exec(body) ?? md.exec(body);
    if (m) hits.push(`${f.path}:${body.slice(0, m.index).split('\n').length}`);
    if (hits.length > 1) return null;   // ambiguous — say less, not more
  }
  return hits.length === 1 ? hits[0] : null;
}

function sampleOf(list, n = 3) {
  return list.slice(0, n).join('; ') + (list.length > n ? ' …' : '');
}


// --- the built pages, read once ----------------------------------------------

// Seven checks below want different fields off the same HTML. Reading every
// sitemap page once per check is seven full walks of dist/ and made the domain
// quadratic on anything large, so the pass happens here and each check is handed
// the result.
// The names the checks below actually pass to the reporter — `meta:unique` is
// two rules, not one, and a skip emitted under a name no check ever uses is a
// catalogue entry with nothing behind it. tools/test.mjs asserts both directions
// and caught exactly that.
const PAGE_RULES = ['html:lang', 'viewport', 'canonical:value', 'links:internal', 'links:orphan', 'meta:unique:title', 'meta:unique:description', 'sitemap:coverage', 'hreflang:valid', 'robots:meta', 'links:anchor-text'];

function scanPages(project) {
  const out = [];
  for (const [loc, file] of sitemapPageFiles(project.root)) {
    const html = readDist(project.root, file);
    const openTag = html.match(/<html\b([^>]*)>/i);
    // Head-scoped, and that is not tidiness. `<title>` is also an SVG element:
    // an inline diagram with labelled nodes puts three of them in the body, and
    // counting those reported "more than one <title>" on four pages of a real
    // documentation site that has exactly one each.
    const head = headOf(html);
    // `markup` is the document with script and style bodies blanked. Anything
    // that looks for TAGS reads this; `html` stays verbatim for anything that
    // needs the bytes as served.
    const markup = blankScripts(html);
    out.push({
      loc, file, html, markup,
      lang: openTag ? attrValue(openTag[1], 'lang') : null,
      titles: [...head.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim()),
      description: head.match(/<meta(?=[^>]*\bname\s*=\s*["']description["'])[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/i)?.[1]?.trim() ?? null,
      canonicals: [...head.matchAll(/<link[^>]+rel=["']canonical["'][^>]*>/gi)]
        .map((m) => m[0].match(/href=["']([^"']+)["']/)?.[1]).filter(Boolean),
      hrefs: [...markup.matchAll(/<a\b[^>]*?\shref=["']([^"']+)["']/gi)].map((m) => m[1]),
    });
  }
  return out;
}

/** Everything before </head>, or the whole document when there is no such tag. */
function headOf(html) {
  const end = html.search(/<\/head\s*>/i);
  if (end >= 0) return html.slice(0, end);
  const body = html.search(/<body\b/i);
  return body >= 0 ? html.slice(0, body) : html;
}

function checkBuiltPages(project, reporter) {
  if (!project.hasDist) {
    skipAll(reporter, PAGE_RULES, 'no dist/ — build the site to read the pages it ships');
    return;
  }
  const pages = scanPages(project);
  if (pages.length === 0) {
    skipAll(reporter, PAGE_RULES, 'no sitemap URL resolves to a built page — nothing to read');
    return;
  }
  checkLang(reporter, pages);
  checkViewport(reporter, pages);
  checkCanonicalValue(reporter, pages);
  checkHreflangValid(project, reporter, pages);
  checkRobotsMeta(project, reporter, pages);
  checkAnchorText(reporter, pages);
  checkLinks(project, reporter, pages);
  checkMetaUnique(project, reporter, pages);
  checkSitemapCoverage(project, reporter, pages);
}

/**
 * `<html lang>` — the one head attribute nothing here has ever read.
 *
 * A screen reader picks its pronunciation from it and a search engine uses it to
 * decide who the page is for; without one both guess. WCAG 3.1.1 is a
 * conformance failure, not a preference, which is why this is required on
 * anyone's site rather than house style. It is also the prerequisite hreflang
 * assumes: alternates that all declare the same language say nothing.
 */
function checkLang(reporter, pages) {
  const missing = pages.filter((p) => !p.lang);
  const malformed = pages.filter((p) => p.lang && !BCP47.test(p.lang));
  if (!missing.length && !malformed.length) {
    const langs = [...new Set(pages.map((p) => p.lang))];
    reporter.pass(SEC, 'html:lang', `all ${pages.length} page(s) declare a language (${langs.slice(0, 4).join(', ')}${langs.length > 4 ? ' …' : ''})`);
    return;
  }
  const parts = [
    missing.length ? `${missing.length} page(s) have no lang on <html> — ${sampleOf(missing.map((p) => p.file))}` : '',
    malformed.length ? `${malformed.length} declare one that is not a language tag — ${sampleOf(malformed.map((p) => `${p.file} (lang="${p.lang}")`))}` : '',
  ].filter(Boolean);
  reporter.fix(SEC, 'html:lang', parts.join('; '), 'set lang on <html> in the root layout (e.g. lang="en", or the page\'s own locale on a multi-locale site)');
}

// Loose BCP 47: a language subtag plus optional script/region/variant. Loose on
// purpose — this is here to catch `lang=""` and `lang="english"`, not to referee
// the registry.
const BCP47 = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/**
 * The page's declaration of its own address, once and absolute.
 *
 * Two canonicals is the failure that reads as diligence: Google discards the
 * pair and falls back to guessing, so a page that declares its URL twice has
 * declared it zero times. A relative canonical is the same class — legal HTML
 * that resolves against whatever URL served the page, which is exactly the
 * parameterised duplicate the canonical existed to collapse. Two <title>s are
 * included because it is the same mistake in the same head: a component
 * emitting one and a layout emitting another.
 */
function checkCanonicalValue(reporter, pages) {
  const many = pages.filter((p) => p.canonicals.length > 1);
  const relative = pages.filter((p) => p.canonicals.length === 1 && !/^[a-z][a-z0-9+.-]*:/i.test(p.canonicals[0]) && !p.canonicals[0].startsWith('//'));
  const twoTitles = pages.filter((p) => p.titles.length > 1);
  if (!many.length && !relative.length && !twoTitles.length) {
    reporter.pass(SEC, 'canonical:value', `all ${pages.length} page(s) declare exactly one absolute canonical and one <title>`);
    return;
  }
  const parts = [
    many.length ? `${many.length} page(s) declare more than one canonical, which makes Google discard all of them — ${sampleOf(many.map((p) => p.file))}` : '',
    relative.length ? `${relative.length} declare a relative canonical, which resolves against whatever URL served the page — ${sampleOf(relative.map((p) => `${p.file} (${p.canonicals[0]})`))}` : '',
    twoTitles.length ? `${twoTitles.length} render more than one <title> — ${sampleOf(twoTitles.map((p) => p.file))}` : '',
  ].filter(Boolean);
  reporter.fix(SEC, 'canonical:value', parts.join('; '), 'emit exactly one canonical, built from the page\'s own absolute URL (new URL(Astro.url.pathname, Astro.site)), from one component');
}

/**
 * Internal links that go nowhere, and pages nothing links to.
 *
 * A 404 behind an `<a>` is invisible to every other check here: the markup is
 * perfect, the target simply is not there. It found a real one on the first run
 * — the bundled i18n fixture's own blog emitted `href="/2"` for page two, which
 * 404s for every visitor who clicks it.
 *
 * Orphans are advisory and always will be. `contact/thanks` in the starter is
 * reached by a form redirect and is *correctly* linked from nowhere; nothing in
 * the build distinguishes that from a page someone forgot to put in the nav.
 * Reporting it is useful, failing a build over it is not.
 */
function checkLinks(project, reporter, pages) {
  const byFile = new Map(pages.map((p) => [p.file, p]));
  const broken = [], linked = new Set();

  for (const page of pages) {
    for (const href of page.hrefs) {
      // Off-site, in-page, and non-http schemes are somebody else's problem —
      // and a mailto: or tel: is not a link this can resolve at all.
      if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
      const path = resolveHref(page.loc, href);
      if (path == null) continue;
      const target = resolveDistPath(project.root, path);
      if (target) { linked.add(target); continue; }
      broken.push(`${page.file} → ${href}`);
    }
  }

  if (broken.length === 0) reporter.pass(SEC, 'links:internal', `every internal link across ${pages.length} page(s) resolves to something this build shipped`);
  else reporter.fix(SEC, 'links:internal', `${broken.length} internal link(s) point at something this build did not produce — ${sampleOf(broken)}`, 'fix the href, or ship the page it names — a link that 404s is invisible to every other check here, because the markup is correct');

  // The homepage is nobody's orphan: it is what a visitor arrives at.
  const orphans = pages.filter((p) => p.file !== 'index.html' && !linked.has(p.file));
  if (orphans.length === 0) reporter.pass(SEC, 'links:orphan', `every published page is linked from at least one other`);
  else reporter.suggest(SEC, 'links:orphan', `${orphans.length}/${pages.length} published page(s) are linked from nowhere on this site — ${sampleOf(orphans.map((p) => p.file))}`, 'link them from the nav, a footer or an index — or, if they are reached by a redirect (a form thank-you page), this is correct and there is nothing to do');
}

/**
 * An href resolved the way a browser resolves it: against the page's URL.
 *
 * Against its FILE PATH is the intuitive version and it is wrong. A page built
 * to `blog/announcing-vite2/index.html` is *served* at `/blog/announcing-vite2`,
 * so `./announcing-vite3` on it means `/blog/announcing-vite3` — the sibling —
 * not a child of itself. Both bundled examples link with absolute paths and so
 * never exercised the difference; a real 57-page site did, and the file-path
 * version reported 99 working links as broken.
 */
function resolveHref(fromLoc, href) {
  try { return decodePath(new URL(href, fromLoc).pathname); } catch { return null; }
}

/**
 * What a path actually serves, or null.
 *
 * Any file counts, not just HTML: `/rss.xml`, `/llms.txt` and `/og/default.png`
 * are perfectly good link targets, and treating them as broken would have
 * reported the starter's own footer.
 */
function resolveDistPath(root, path) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!clean) return isFile(root, 'index.html') ? 'index.html' : null;
  // Directory forms FIRST, and the bare path only if it is a regular file.
  // `existsSync` is true for a directory, so `/blog` "resolved" to the `blog/`
  // folder rather than to `blog/index.html` — every link to a section landed on
  // a path no page could ever match, and links:orphan reported 42 of 43 pages
  // as unlinked on a site whose nav works.
  for (const candidate of [`${clean}/index.html`, `${clean}.html`, clean]) {
    if (isFile(root, candidate)) return candidate;
  }
  return null;
}

function isFile(root, rel) {
  try { return statSync(join(distDir(root), rel)).isFile(); } catch { return false; }
}

/**
 * Two pages, one title — with the one exemption that keeps it honest.
 *
 * A duplicate title or description tells a crawler two URLs are the same page,
 * which is the thing canonical exists to say deliberately. Locale pairs are the
 * legitimate case and they are common: the fixture's four en/hu pairs share a
 * title by design, so a page is exempt when the sitemap already declares the
 * other as its hreflang alternate — the same discriminator `sitemap:canonical`
 * uses.
 *
 * Unlike `canonical:unique` this has no majority threshold, because the two
 * findings are not the same shape: a canonical shared site-wide de-indexes the
 * site and a canonical shared by two pages is usually deliberate, whereas two
 * pages with the same title is already a problem for those two. Advisory in
 * every mode, which is what makes the lower bar affordable.
 */
function checkMetaUnique(project, reporter, pages) {
  const alternates = new Map();
  for (const e of sitemapEntries(project.root).entries) {
    alternates.set(normalizeUrl(e.loc)?.path, new Set(e.alternates.map((a) => normalizeUrl(a)?.path)));
  }
  const paired = (a, b) => {
    const [pa, pb] = [normalizeUrl(a.loc)?.path, normalizeUrl(b.loc)?.path];
    return alternates.get(pa)?.has(pb) || alternates.get(pb)?.has(pa);
  };

  const report = (field, get) => {
    const groups = new Map();
    for (const p of pages) {
      const v = get(p);
      if (!v) continue;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(p);
    }
    // A group is a finding only once the locale pairs are taken out of it.
    const dupes = [...groups.entries()]
      .map(([value, ps]) => [value, ps.filter((p, i) => !ps.some((q, j) => j !== i && paired(p, q)) || ps.filter((q) => !paired(p, q)).length > 1)])
      .filter(([, ps]) => ps.length > 1)
      .sort((a, b) => b[1].length - a[1].length);
    if (dupes.length === 0) {
      reporter.pass(SEC, `meta:unique:${field}`, `${groups.size} distinct ${field}(s) across ${pages.length} page(s)`);
      return;
    }
    const worst = dupes[0];
    reporter.suggest(SEC, `meta:unique:${field}`, `${dupes.length} ${field}(s) are shared by more than one page — the worst covers ${worst[1].length}: "${truncate(worst[0], 50)}" on ${sampleOf(worst[1].map((p) => p.file))}`, `give each page its own ${field}; two pages with the same one tell a crawler they are the same page`);
  };

  report('title', (p) => p.titles[0]);
  report('description', (p) => p.description);
}

/**
 * The inverse of the denominator: what got built and never declared.
 *
 * Every coverage check here judges the pages the sitemap lists. This is the only
 * one that asks what the sitemap left out — a page that ships, is indexable, and
 * is not submitted is a page relying on being stumbled upon.
 *
 * Four exemptions, each measured rather than assumed. An error page is the one
 * that caught us out: both bundled examples ship a `404.html` carrying a
 * canonical and no noindex, so it looks publishable to every test above and must
 * never be submitted.
 */
function checkSitemapCoverage(project, reporter, pages) {
  const declared = new Set(pages.map((p) => p.file));
  const rules = robotsRules(readDist(project.root, 'robots.txt'));
  const missing = [];
  eachDistHtml(project.root, (rel, html) => {
    const file = distRelative(project.root, rel);
    if (declared.has(file)) return;
    if (ERROR_PAGE.test(file)) return;                    // 404/500 — shipped, never submitted
    if (!isContentPage(html)) return;                     // no canonical: an OG template or preview route
    if (NOINDEX_RE.test(html)) return;                    // deliberately withheld, and sitemap:noindex owns that case
    const path = `/${file.replace(/index\.html$/, '').replace(/\.html$/, '')}`;
    if (rules.length && isBlocked(rules, path)) return;   // robots.txt already says don't
    missing.push(file);
  });

  if (missing.length === 0) reporter.pass(SEC, 'sitemap:coverage', `every indexable built page is in the sitemap (${pages.length})`);
  else reporter.fix(SEC, 'sitemap:coverage', `${missing.length} built page(s) look publishable but are not in the sitemap — ${sampleOf(missing)}`, 'include them (they are in dist/, carry a canonical and are not noindex), or exclude them deliberately with @astrojs/sitemap\'s filter');
}

const ERROR_PAGE = /(^|\/)(404|500)(\/index)?\.html$/i;

/**
 * `Disallow: /` for every crawler — the whole site, withheld.
 *
 * Nearly always a staging robots.txt that shipped, and it is total: no sitemap,
 * canonical or JSON-LD below it can matter. Resolved with the same longest-match
 * logic as `sitemap:blocked`, so a `Disallow: /` that a longer `Allow:` reopens
 * is correctly not a finding.
 */
function checkRobotsScope(project, reporter) {
  if (!project.hasDist) {
    reporter.skip(SEC, 'robots:blocks-all', 'no dist/ — build the site to read the robots.txt it ships');
    return;
  }
  const text = readDist(project.root, 'robots.txt');
  if (!text.trim()) {
    reporter.skip(SEC, 'robots:blocks-all', 'no robots.txt in dist/ — seo: robots reports that; there is no rule here to read');
    return;
  }
  const rules = robotsRules(text);
  const blocking = isBlocked(rules, '/');
  if (blocking) {
    reporter.fix(SEC, 'robots:blocks-all', `dist/robots.txt disallows the whole site for every crawler (Disallow: ${blocking}) — nothing else in this audit can matter while that ships`, 'remove the site-wide Disallow, or narrow it to the paths you actually mean to withhold', { file: 'dist/robots.txt' });
    return;
  }
  reporter.pass(SEC, 'robots:blocks-all', rules.length ? `${rules.length} rule(s) for *, none of which blocks the site root` : 'nothing disallowed for *', { file: 'dist/robots.txt' });
}

/**
 * The favicon Google Search can actually use.
 *
 * Google's own list: "BMP, GIF, ICO, PNG, JPEG, PPM, and TIFF" — SVG is not on
 * it, and this is not a technicality. Three sites in a 27-site sweep ship an
 * SVG as their only icon and serve no /favicon.ico, so their results carry the
 * generic globe; our own starter did the same until this check was written.
 * Square, at least 8×8, and Google recommends above 48×48.
 *
 * Two carriers, both accepted. The documented one is a <link> on the HOME PAGE
 * ("Add a <link> tag to the header of your home page"), and Google names four
 * rel values for it. The other is /favicon.ico at the root, which the page does
 * not document — but michelin.com, porsche.com and feature.undp.org all ship
 * NO link tag at all and are served a favicon from it, verified 2026-09-06. A
 * check that flagged those three would be wrong about three real sites, so the
 * root file counts.
 *
 * Verified against developers.google.com/search/docs/appearance/favicon-in-search
 * (last updated 2026-08-28) on 2026-09-06.
 */
const FAVICON_REL_RE = /\b(?:shortcut\s+)?icon\b|\bapple-touch-icon(?:-precomposed)?\b/i;
// Google's list, lowercased, plus the extensions those formats actually ship as.
const FAVICON_OK_EXT = new Set(['.ico', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ppm', '.tif', '.tiff']);

function checkFavicon(project, reporter) {
  if (!project.hasDist) {
    reporter.skip(SEC, 'favicon', 'no dist/ — build the site to read the icon its home page declares');
    return;
  }
  const home = readDist(project.root, 'index.html');
  if (!home) {
    reporter.skip(SEC, 'favicon', 'no dist/index.html — the icon is read from the home page, and there is none');
    return;
  }
  const rootIco = existsSync(join(distDir(project.root), 'favicon.ico'));
  const links = [...headOf(home).matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)]
    .map((m) => ({ rel: attrValue(m[1], 'rel') ?? '', href: attrValue(m[1], 'href') ?? '' }))
    .filter((l) => FAVICON_REL_RE.test(l.rel) && l.href);
  const usable = links.filter((l) => FAVICON_OK_EXT.has(extOf(l.href)));

  if (usable.length) {
    reporter.pass(SEC, 'favicon', `the home page declares ${usable.length} icon Google can read (${usable.map((l) => truncate(l.href, 40)).join(', ')})`,
      { file: 'dist/index.html' });
  } else if (rootIco) {
    reporter.pass(SEC, 'favicon', links.length
      ? `no icon <link> in a format Google reads, but /favicon.ico is served — the root file is the fallback every crawler tries`
      : '/favicon.ico is served — the root file is the fallback every crawler tries, so no <link> is needed',
      { file: 'dist/favicon.ico' });
  } else if (links.length) {
    const exts = [...new Set(links.map((l) => extOf(l.href) || '?'))].join(', ');
    reporter.fix(SEC, 'favicon',
      `the only icon(s) the home page declares are ${exts} — Google Search reads BMP, GIF, ICO, PNG, JPEG, PPM and TIFF, and no /favicon.ico is served either, so the result shows a generic globe`,
      'keep the SVG for browsers and add a raster beside it: a square PNG larger than 48×48, or a /favicon.ico at the root',
      { file: 'dist/index.html' });
  } else {
    reporter.fix(SEC, 'favicon',
      'the home page declares no icon and no /favicon.ico is served — the search result shows a generic globe',
      'add <link rel="icon" href="/favicon.png"> to the head, pointing at a square PNG larger than 48×48',
      { file: 'dist/index.html' });
  }

  // Dimensions, but only when the file is local and its format is one we can
  // read. An unreadable icon is a missed finding, never a wrong one.
  const local = usable.map((l) => l.href).find((h) => h.startsWith('/') && !h.startsWith('//'));
  if (!local) { reporter.skip(SEC, 'favicon:size', 'no local raster icon to measure'); return; }
  const abs = join(distDir(project.root), decodePath(local.split(/[?#]/)[0]).replace(/^\/+/, ''));
  const at = { file: relative(project.root, abs) };
  let dims = null;
  try { dims = existsSync(abs) ? imageSize(readFileSync(abs)) : null; } catch { dims = null; }
  if (!dims) {
    reporter.skip(SEC, 'favicon:size', `could not read the dimensions of ${truncate(local, 50)} — ICO is not a format this tool decodes, and an unreadable one is a missed finding rather than a wrong one`);
  } else if (dims.w !== dims.h) {
    reporter.fix(SEC, 'favicon:size', `${truncate(local, 50)} is ${dims.w}×${dims.h} — Google requires a square (1:1) favicon`,
      'export it square; a non-square icon is dropped rather than cropped', at);
  } else if (dims.w < 48) {
    reporter.suggest(SEC, 'favicon:size', `${truncate(local, 50)} is ${dims.w}×${dims.h} — above Google's 8px minimum, under the 48px it recommends`,
      'export at 96×96 or larger so it stays sharp on every surface Google shows it', at);
  } else {
    reporter.pass(SEC, 'favicon:size', `${truncate(local, 50)} is ${dims.w}×${dims.h} — square and above the 48px Google recommends`, at);
  }
}

const extOf = (href) => {
  const clean = String(href).split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot > clean.lastIndexOf('/') ? clean.slice(dot).toLowerCase() : '';
};

/**
 * `<meta name="viewport">` on every built page.
 *
 * Page experience asks whether content "displays well on mobile devices", and
 * without this meta a mobile browser lays the page out at desktop width and
 * scales it down — every tap target too small, every line too long. It is one
 * line in the root layout, so a page without it is nearly always a page that
 * never went through the layout.
 */
function checkViewport(reporter, pages) {
  const missing = pages.filter((p) => !hasViewport(headOf(p.html)));
  if (!missing.length) {
    reporter.pass(SEC, 'viewport', `all ${pages.length} built page(s) declare a viewport`);
    return;
  }
  reporter.fix(SEC, 'viewport',
    `${missing.length}/${pages.length} built page(s) have no <meta name="viewport"> — a phone lays these out at desktop width and scales them down — ${sampleOf(missing.map((p) => p.file))}`,
    'add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head component every page renders');
}
// Reads the tag, for the reason metaFilled() gives above: every lookahead
// spelling of "content is non-empty" can be satisfied by a quote in a LATER
// tag, so `content=""` reads as declared.
const hasViewport = (html) => hasFilledMeta(html, 'viewport');

/**
 * hreflang alternates that a crawler can actually follow.
 *
 * `seo: hreflang` asks whether alternates exist at all. This asks whether the
 * ones that exist are usable, which is four separate documented rules and three
 * of them fired on a 27-site sweep:
 *
 *   - fully-qualified hrefs. "Alternate URLs must be fully-qualified, including
 *     the transport method." 13 pages of one real site declare `../fr/`.
 *   - a language subtag Google parses: ISO 639-1, optionally an ISO 15924
 *     script, optionally an ISO 3166-1 alpha-2 region — and nothing else. "Only
 *     language codes listed in ISO 639-1 and region codes listed in ISO 3166-1
 *     Alpha 2 are supported; other codes … such as es-419, aren't supported."
 *     So a three-letter language (`fil`) and a UN M.49 region (`es-419`) are
 *     findings, though both are valid BCP 47. `en-UK` is the classic error (the
 *     country is GB), and one real site ships `en-AE-x-dubai`, a private-use
 *     tag Google does not read. Case does not matter: "The hreflang value is
 *     case-insensitive" — uppercase regions are convention, not a rule.
 *   - self-reference: "each language version must list itself".
 *   - return links: "if page X links to page Y, page Y must link back to page X",
 *     or the annotations may be ignored. Checked only between pages this build
 *     produced — an alternate on another host is not ours to verify.
 *
 * Verified against developers.google.com/search/docs/specialty/international/localized-versions
 * (last updated 2026-09-21) on 2026-10-03.
 */
function checkHreflangValid(project, reporter, pages) {
  const withAlts = pages
    .map((p) => ({ page: p, alts: alternatesOf(headOf(p.html)) }))
    .filter((x) => x.alts.length);
  if (!withAlts.length) {
    reporter.skip(SEC, 'hreflang:valid', 'no built page carries a <link rel="alternate" hreflang> — seo: hreflang reports whether one should');
    return;
  }

  const relative = [], badCode = [], noSelf = [], oneWay = [];
  // Every declared alternate, keyed by the URL it points at, so a return link
  // can be looked up without re-parsing.
  const declares = new Map();
  for (const { page, alts } of withAlts) {
    const self = normalizeUrl(page.canonicals[0] ?? page.loc);
    declares.set(keyOf(self), new Set(alts.map((a) => keyOf(normalizeUrl(a.href, page.loc))).filter(Boolean)));
  }

  for (const { page, alts } of withAlts) {
    const self = normalizeUrl(page.canonicals[0] ?? page.loc);
    for (const a of alts) {
      if (!/^https?:\/\//i.test(a.href)) relative.push(`${page.file} → hreflang="${a.code}" href="${truncate(a.href, 40)}"`);
      if (!HREFLANG_CODE.test(a.code) || BAD_REGION.test(a.code)) badCode.push(`${page.file} → hreflang="${truncate(a.code, 24)}"`);
    }
    const selfKey = keyOf(self);
    if (selfKey && !alts.some((a) => keyOf(normalizeUrl(a.href, page.loc)) === selfKey)) {
      noSelf.push(`${page.file} lists ${alts.length} alternate(s), none of them itself`);
    }
    for (const a of alts) {
      const target = keyOf(normalizeUrl(a.href, page.loc));
      // Only pages this build produced: a page we never wrote cannot be asked
      // to link back, and asserting otherwise would flag a correct external
      // alternate.
      if (!target || !declares.has(target) || target === selfKey) continue;
      if (!declares.get(target).has(selfKey)) {
        oneWay.push(`${page.file} → ${truncate(a.href, 40)}, which does not link back`);
      }
    }
  }

  const parts = [
    relative.length ? `${relative.length} alternate(s) use a relative href — Google requires fully-qualified URLs — ${sampleOf(relative)}` : '',
    badCode.length ? `${badCode.length} declare a language tag Google cannot parse — ${sampleOf(badCode)}` : '',
    noSelf.length ? `${noSelf.length} page(s) do not list themselves — ${sampleOf(noSelf)}` : '',
    oneWay.length ? `${oneWay.length} alternate pair(s) are one-way — ${sampleOf(oneWay)}` : '',
  ].filter(Boolean);

  if (!parts.length) {
    reporter.pass(SEC, 'hreflang:valid', `all alternates on ${withAlts.length} page(s) are absolute, self-referencing, reciprocal and use a parseable language tag`);
    return;
  }
  reporter.fix(SEC, 'hreflang:valid', parts.join('; '),
    'an hreflang cluster is only read when every member lists every member, itself included, by absolute URL and with a real language[-script][-region] tag (en-GB, not en-UK)');
}

// `<link rel="alternate" hreflang="…" href="…">`, in either attribute order.
function alternatesOf(head) {
  const out = [];
  for (const m of head.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const rel = attrValue(m[1], 'rel') ?? '';
    if (!/\balternate\b/i.test(rel)) continue;
    const code = attrValue(m[1], 'hreflang');
    const href = attrValue(m[1], 'href');
    if (code && href) out.push({ code, href });
  }
  return out;
}
// ISO 639-1 language, optional ISO 15924 script, optional ISO 3166-1 alpha-2
// region — the subset of BCP 47 Google supports, which excludes three-letter
// languages and UN M.49 regions by name. No private-use (`-x-…`) branch either:
// Google reads the registry, not an extension.
const HREFLANG_CODE = /^(?:x-default|[a-z]{2}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?)$/i;
// Codes that parse as regions but are not ISO 3166-1 alpha-2. UK is the one
// everybody writes; the country is GB.
const BAD_REGION = /-(?:UK|EU|UN)$/i;

const keyOf = (u) => (u ? `${u.origin}${u.path.replace(/\/$/, '')}` : null);

/**
 * Robots meta directives Google actually implements, and the trap where a
 * directive can never be read.
 *
 * A misspelled directive is silent: `noidex` is ignored, and the page is
 * indexed by a site that believes it withheld it. And a `noindex` on a URL
 * robots.txt disallows is worse than useless — Google is forbidden to fetch the
 * page, so it never sees the tag and may index the URL anyway from links.
 * Google states this outright: if a page is disallowed, "any information about
 * indexing or serving rules will not be found and will therefore be ignored".
 *
 * Verified against developers.google.com/search/docs/crawling-indexing/robots-meta-tag
 * (last updated 2026-03-24) on 2026-09-06.
 */
function checkRobotsMeta(project, reporter, pages) {
  const withMeta = pages
    .map((p) => ({ page: p, directives: robotsDirectives(headOf(p.html)) }))
    .filter((x) => x.directives.length);
  if (!withMeta.length) {
    reporter.skip(SEC, 'robots:meta', `none of the ${pages.length} built page(s) carries a robots meta — there is nothing here to misread`);
    return;
  }

  const unknown = [], unreadable = [];
  const rules = robotsRules(readDist(project.root, 'robots.txt'));
  for (const { page, directives } of withMeta) {
    for (const d of directives) {
      const base = d.split(':')[0];
      if (!ROBOTS_DIRECTIVES.has(base)) unknown.push(`${page.file} → "${truncate(d, 30)}"`);
    }
    if (!directives.some((d) => /^noindex$|^none$/.test(d))) continue;
    const path = normalizeUrl(page.loc)?.path;
    const blocking = path && rules.length ? isBlocked(rules, path) : null;
    if (blocking) unreadable.push(`${page.file} (robots.txt: Disallow: ${blocking})`);
  }

  const parts = [
    unknown.length ? `${unknown.length} directive(s) are not ones Google implements, so they do nothing — ${sampleOf(unknown)}` : '',
    unreadable.length ? `${unreadable.length} page(s) carry noindex on a URL robots.txt disallows — Googlebot may never fetch the page, so it never reads the tag — ${sampleOf(unreadable)}` : '',
  ].filter(Boolean);

  if (!parts.length) {
    reporter.pass(SEC, 'robots:meta', `all robots meta directives on ${withMeta.length} page(s) are ones Google implements, and none sits on a URL robots.txt withholds`);
    return;
  }
  reporter.fix(SEC, 'robots:meta', parts.join('; '),
    'spell directives as Google documents them, and never pair noindex with a Disallow — to drop a page from the index, let it be crawled and let the noindex do the work');
}

function robotsDirectives(head) {
  const out = [];
  for (const m of head.matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const name = (attrValue(m[1], 'name') ?? '').toLowerCase();
    if (name !== 'robots' && name !== 'googlebot') continue;
    for (const d of (attrValue(m[1], 'content') ?? '').split(',')) {
      const t = d.trim().toLowerCase();
      if (t) out.push(t);
    }
  }
  return out;
}
// Every rule the robots-meta page documents, page-level and text-level.
const ROBOTS_DIRECTIVES = new Set([
  'all', 'noindex', 'nofollow', 'none', 'noarchive', 'nosnippet', 'indexifembedded',
  'max-snippet', 'max-image-preview', 'max-video-preview', 'notranslate', 'noimageindex',
  'unavailable_after',
  // Not in the current docs, but historically honoured and harmless to see.
  'index', 'follow', 'nocache',
]);

/**
 * Link text that says what is on the other end.
 *
 * "Avoid writing generic anchor text like page, article, or click here."
 * Advisory, and it will stay advisory: a blog card whose whole surface is the
 * link legitimately reads "Read more", and 29 of the 66 hits in a 27-site sweep
 * were exactly that pattern. What makes it worth reporting anyway is that a
 * screen-reader user tabbing through links hears the list on its own, where
 * nine identical "Read more" say nothing at all.
 *
 * Verified against developers.google.com/search/docs/crawling-indexing/links-crawlable
 * (last updated 2025-12-10) on 2026-09-06.
 */
function checkAnchorText(reporter, pages) {
  const hits = new Map();
  let total = 0;
  for (const p of pages) {
    for (const m of p.markup.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi)) {
      if (!attrValue(m[1], 'href')) continue;
      total++;
      // The accessible name, near enough: an image-only link takes its alt, and
      // aria-label wins over both — flagging a link that HAS a name because the
      // name is not in the text would be wrong.
      const label = attrValue(m[1], 'aria-label')
        ?? (m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          || attrValue(m[2].match(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i)?.[1] ?? '', 'alt')
          || '');
      const norm = label.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[.!?…»→]+$/, '').trim();
      if (!norm || !GENERIC_ANCHOR.test(norm)) continue;
      const key = norm;
      if (!hits.has(key)) hits.set(key, { text: label.trim(), n: 0, files: new Set() });
      const h = hits.get(key);
      h.n++; h.files.add(p.file);
    }
  }
  if (!total) { reporter.skip(SEC, 'links:anchor-text', 'no links on the built pages read — nothing to check'); return; }
  if (!hits.size) {
    reporter.pass(SEC, 'links:anchor-text', `none of the ${total} link(s) on ${pages.length} page(s) relies on generic text`);
    return;
  }
  const worst = [...hits.values()].sort((a, b) => b.n - a.n);
  reporter.suggest(SEC, 'links:anchor-text',
    `${worst.reduce((n, h) => n + h.n, 0)}/${total} link(s) use generic text — ${sampleOf(worst.map((h) => `"${truncate(h.text, 24)}" ×${h.n}`))}`,
    'name the destination in the link itself ("Read the 2026 fee schedule"), so the text works out of context — which is how a search engine and a screen reader both read it');
}
const GENERIC_ANCHOR = /^(?:click here|read more|more|here|this|learn more|find out more|link|continue|continue reading|see more|view more|details|read|go|page|article)$/i;
