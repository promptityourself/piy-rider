// live — runtime checks against a running/deployed URL.
//
// Where the offline checks read source + dist, this hits real URLs and verifies
// what only exists at serve time: Cache-Control headers, image routing + bytes,
// the SEO surface in rendered HTML, and machine-readable endpoints (/llms.txt).
// Only runs when --url is passed. Point it at a dev preview, a `wrangler dev` of
// dist/, or production.

import { transformSmells, transformApplied } from '../lib/cf-image.mjs';
import { headingLevels, headingAudit, attrValue, hasAttr } from '../lib/html.mjs';
import { imageSize } from '../lib/image-size.mjs';
import { collectJsonLd, ldTypes, hasArticleType, classifyPage } from '../lib/jsonld.mjs';
import { untrusted, capped, UNTRUSTED_NOTE } from '../lib/untrusted.mjs';
import { declaresImmutableAssets } from '../lib/headers.mjs';
import { outOfFlowSelectors, inlineStyles, stylesheetHrefs, isOutOfFlow } from '../lib/css-flow.mjs';
import {
  BEACON_SIGNALS, RUM_SIGNALS, ZARAZ_SIGNALS, GA_THIRD_PARTY_SIGNALS,
  matchSignals, hasSignal, beaconScriptCount,
} from '../lib/analytics-signals.mjs';
import { truncate } from '../lib/text.mjs';

// One image loop can otherwise emit a finding per <img> on a page that has
// hundreds — or that was built to have hundreds.
const MAX_IMAGE_FINDINGS = 25;

// Neither `astro dev` nor `astro preview` applies _headers (measured), so a
// cache verdict against one says nothing about the deploy — in either
// direction. `wrangler dev` of the same build DOES apply it (also measured:
// /_astro/* came back `public, max-age=31536000, immutable`), which is why the
// caveat is about the server, never about being on localhost.
const LOCAL_CAVEAT = ' — NB against `astro dev`/`astro preview` this proves nothing: neither applies _headers. Judge it on `wrangler dev` of dist/ or the deployed site';

// A host that accepts the connection and never answers used to hang the audit
// indefinitely — in CI, forever.
const NET_TIMEOUT_MS = 15_000;

// What a modern browser sends for an image — so a format=auto transform negotiates
// AVIF/webp and the measured bytes reflect what a real visitor actually downloads.
const BROWSER_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

// A minimal browser identity, safe on any request (page or sub-resource).
const BROWSER_BASE = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
};

// A full top-level-navigation signature. A headerless fetch is bot-scored by
// Cloudflare as automated, and Zaraz's "Block bot initiated requests" setting
// (bot-score based — same effect as Bot Fight Mode) then suppresses the
// edge-injected /cdn-cgi/zaraz/i.js loader. So a curl-shaped probe never sees
// Zaraz, even when it is correctly configured. Sending what a browser sends for a
// document request gets the fully-injected page a real visitor receives.
// (Cloudflare docs: Zaraz Settings → "Block bot initiated requests".)
const NAV_HEADERS = {
  ...BROWSER_BASE,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export async function run({ base, reporter, post, project = null }) {
  const get = mkGet(base);
  const head = mkHead(base);

  // Reachability
  const home = await get('/');
  if (!home.ok) {
    reporter.block('live', 'reachability', `cannot reach ${home.url}: ${home.error}`, 'is the server running? check the URL/port');
    return;
  }
  if (home.status !== 200) {
    reporter.block('live', 'reachability', `${base}/ returned ${home.status}`, 'expected 200 for the homepage');
    return;
  }
  reporter.pass('live', 'reachability', `${base}/ → 200`);
  reporter.skip('live', 'untrusted-input', UNTRUSTED_NOTE);

  await auditCache(home, head, reporter, project, base);
  const postPath = await resolveSlash(post ?? (await discoverPost(home, base, get)), get);
  await auditSeo(home, postPath, base, get, head, reporter);
  await auditImages(home, postPath, base, get, head, reporter);
  await auditData(get, reporter);
  auditAnalytics(home, reporter);
}

// Analytics — served HTML is the authoritative reader, because both supported
// deliveries can be invisible offline. Cloudflare injects the Web Analytics
// beacon at the edge for proxied sites (automatic install is on by default), and
// Zaraz injects its loader (/cdn-cgi/zaraz/) at the edge always. Either one here
// means the site is measured.
//
// NB both are only visible because the page GET carries a full browser
// navigation signature (NAV_HEADERS) — a headerless probe is bot-scored and the
// edge suppresses the Zaraz injection for it.
//
// Three rules, one meaning each:
//   provider  what delivers analytics (advisory in both modes — see analytics.mjs)
//   zaraz     the Zaraz loader specifically, with its consent caveat
//   ga:raw    GA fetched straight from a Google origin, bypassing any consent gate
//
// A bare gtag() *call* is NOT flagged live: when Zaraz delivers GA it injects
// that bootstrap into the rendered HTML, so keying on the call (as the offline
// scan does for source) would flag every compliant served page.
function auditAnalytics(home, reporter) {
  const html = home.text;
  const beacon = matchSignals(html, [...BEACON_SIGNALS, ...RUM_SIGNALS]);
  const zaraz = hasSignal(html, ZARAZ_SIGNALS);
  const thirdPartyGa = hasSignal(html, GA_THIRD_PARTY_SIGNALS);
  const beaconTags = beaconScriptCount(html);

  // provider — what is delivering analytics here.
  if (beacon.length && zaraz) {
    reporter.pass('analytics', 'provider', `both Cloudflare Web Analytics (${beacon.join(', ')}) and Zaraz are on the page — deliberate if Zaraz carries other tools, duplicated measurement if not`);
  } else if (beaconTags > 1) {
    reporter.suggest('analytics', 'provider', `${beaconTags} Cloudflare Web Analytics beacons on the page — usually the layout's own snippet plus the one automatic setup injects at the edge, so every visit is counted ${beaconTags} times`, "keep one install: turn automatic setup off in the dashboard, or unset the token in the layout so only the edge injects it");
  } else if (beacon.length) {
    reporter.pass('analytics', 'provider', `Cloudflare Web Analytics (${beacon.join(', ')}) — cookieless, so no consent banner is required`);
  } else if (zaraz) {
    reporter.pass('analytics', 'provider', 'Cloudflare Zaraz — analytics is edge-managed behind its consent CMP');
  } else {
    reporter.suggest('analytics', 'provider', 'no Cloudflare Web Analytics beacon and no Zaraz loader in the served HTML — this page is measuring nothing', 'turn on Cloudflare Web Analytics (free, cookieless, no banner): for a proxied site the dashboard injects the beacon for you, otherwise add the one <script> to the root layout');
  }

  // zaraz — the loader specifically, kept with its caveat.
  if (zaraz) {
    reporter.pass('analytics', 'zaraz', 'Zaraz loader present (/cdn-cgi/zaraz/). NB this confirms the loader only — the consent CMP actually rendering, and tags holding until consent, are client-side runtime and are not checked here (see BEST-PRACTICES § Gaps)');
  } else {
    reporter.skip('analytics', 'zaraz', 'no Zaraz loader in served HTML — either Zaraz is not configured for this zone (a legitimate choice; Web Analytics needs no tag manager), or the edge blocks all bot traffic / a WAF rule strips the loader. The probe does send a browser navigation signature, so the first is the likely reading');
  }

  // ga:raw — its own rule in both branches. Reporting the no-Zaraz case under
  // the `zaraz` id gave one id three meanings, so nothing could be filtered on.
  if (thirdPartyGa) {
    reporter.fix(
      'analytics',
      'ga:raw',
      `Google Analytics is loaded directly from a Google origin${zaraz ? ' as well as through Zaraz' : ''} — it fires outside any consent gate`,
      zaraz
        ? 'remove the third-party GA loader; let Zaraz deliver it behind the consent CMP'
        : 'either deliver GA through Cloudflare Zaraz so its consent CMP gates it, or drop GA for Cloudflare Web Analytics, which is cookieless and needs no gate',
    );
  }
}

// Cache — hashed assets immutable, HTML revalidates --------------------------

async function auditCache(home, head, reporter, project, base) {
  // Whether the server honoured _headers at all, as MEASURED on the asset —
  // null when there was nothing to measure. It decides what the HTML verdict
  // below is worth: an immutable asset response is something only a server that
  // applied the file can produce, so on the same server the HTML result is
  // meaningful too.
  let appliesHeaders = null;

  const asset = firstHashedAsset(home.text);
  if (!asset) {
    reporter.skip('perf', 'cache:_astro', 'no /_astro/* asset referenced on homepage — nothing to check');
  } else {
    const r = await head(asset);
    if (!r.ok || r.status >= 400) {
      reporter.fix('perf', 'cache:_astro', `${asset} → ${r.status ?? r.error}`, 'hashed asset should be reachable');
    } else {
      const cc = (r.headers.get('cache-control') || '').toLowerCase();
      const immutable = /\bimmutable\b/.test(cc);
      const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1] ?? 0);
      appliesHeaders = immutable && maxAge >= 86400;
      if (appliesHeaders) {
        // No caveat here, deliberately. An immutable response is something only
        // a server that applied the rule can produce — `wrangler dev` returns it,
        // `astro preview` cannot — so this pass is proof wherever it came from.
        reporter.pass('perf', 'cache:_astro', untrusted(cc || '(none)', 80));
      } else if (ignoresHeadersFile(project, base)) {
        // The project's own _headers declares /_astro/* immutable and this is a
        // local server that served it otherwise — so the server is ignoring the
        // file, which is what `astro dev`/`astro preview` do. Explaining a
        // finding that could not have gone any other way is not a finding.
        reporter.skip(
          'perf',
          'cache:_astro',
          `served ${untrusted(cc || '(none)', 60)} by a local server that does not apply _headers — public/_headers marks /_astro/* immutable, so there is nothing here to judge. Re-run against \`wrangler dev\` of dist/ (measured: it does apply the file) or the deployed site`,
        );
      } else {
        reporter.fix(
          'perf',
          'cache:_astro',
          `Cache-Control ${untrusted(cc || '(none)', 80)} — hashed asset not immutable (repeat visits re-validate)`,
          'ship public/_headers marking /_astro/* "public, max-age=31536000, immutable". NB: neither `astro dev` nor `astro preview` applies _headers — both serve /_astro/* as no-cache regardless (measured), so run against `wrangler dev` of dist/ or the deployed site to judge it',
        );
      }
    }
  }

  const htmlCC = (home.headers.get('cache-control') || '').toLowerCase();
  if (/\bimmutable\b/.test(htmlCC)) {
    reporter.fix('perf', 'cache:html', `homepage Cache-Control ${untrusted(htmlCC, 80)} is immutable — deploys won't show until cache expires`, 'do not list HTML routes in _headers; let them revalidate');
  } else {
    // The caveat belongs here only when the server was shown NOT to apply
    // _headers: "not immutable" is what a dev server returns by default, so
    // passing on one proves nothing. On a server measured to apply the file
    // (wrangler dev, the deploy) the same pass is real, and the caveat would be
    // the misleading half.
    reporter.pass('perf', 'cache:html', `homepage revalidates (${untrusted(htmlCC || 'default', 80)})${appliesHeaders === false ? LOCAL_CAVEAT : ''}`);
  }
}

/**
 * Is this a local server that demonstrably ignores `public/_headers`?
 *
 * Both halves are required. Being on localhost is not enough — `wrangler dev`
 * is local too and applies the file correctly (measured), so skipping on host
 * alone would hide a real finding on the one local server that can produce it.
 * And a correct `_headers` is not enough either: a deployed site whose host
 * ignores the file is exactly the bug this check exists to catch.
 *
 * Without a project in cwd (`--url` from anywhere) there is no file to read, so
 * this is false and the finding stands.
 */
function ignoresHeadersFile(project, base) {
  if (!project) return false;
  return isLocalOrigin(base) && declaresImmutableAssets(project.root);
}

/** Is this URL a loopback or private-network address — i.e. a stand-in for the real site? */
function isLocalOrigin(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    || /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

// SEO — real HTML on home + a content page -----------------------------------

// What is lost when no content page can be found. Listing them is the whole
// point: "clean" must never be indistinguishable from "didn't run".
const POST_ONLY_CHECKS = [
  'seo/title', 'seo/description', 'seo/canonical', 'seo/og-title', 'seo/og-image',
  'seo/og-image-width', 'seo/og-image-height', 'seo/og-url', 'seo/og-image-resolves',
  'seo/og-image-card', 'seo/headings-h1', 'seo/headings-order', 'data/post-jsonld',
];

/**
 * The canonical URL must answer directly — 200, not a redirect.
 *
 * Found on the starter itself, 2026-09-02: Astro builds `about/index.html` and
 * declares `trailingSlash: 'never'`, so every canonical is `/about`; Workers'
 * default `html_handling` (auto-trailing-slash) serves a folder index only at
 * `/about/` and answers `/about` with a 307. Every canonical on the site
 * redirected and the live audit said clean, because every fetch here follows
 * redirects. A search engine that follows it indexes a URL the site never
 * declares as its own, and every share link pays a round trip first. The
 * declared URL and the served URL have to be the same string.
 */
async function checkCanonicalDirect(pages, base, reporter) {
  // Either attribute order. Requiring `rel` before `href` made a valid
  // `<link href="…" rel="canonical">` invisible, and the check then reported
  // "no canonical declared" while seo:canonical passed on the same page — a
  // false skip, which reads exactly like a clean result.
  const canonicalHref = (html) =>
    html.match(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["']/i)?.[1] ?? null;
  const declared = pages
    .map(({ html, path }) => ({ path, href: canonicalHref(html) }))
    .filter((p) => p.href);
  if (!declared.length) { reporter.skip('seo', 'canonical:direct', 'no canonical declared on the fetched pages — canonical checks above say so'); return; }

  // Re-rooting is only right when the audited origin is standing IN for the
  // declared one — a local or private-network serve of a site that names its
  // production URL. Doing it unconditionally reported two correct
  // configurations as broken: a site auditing on the apex that canonicalises to
  // www (the redirect is the point), and a syndicated page whose canonical
  // legitimately names another domain. On a public origin the canonical is
  // fetched exactly as declared, which is what a crawler does.
  const rebase = isLocalOrigin(base);
  const bad = [];
  for (const { path, href } of declared) {
    let url, shown;
    try {
      const u = new URL(href, base);
      shown = rebase ? u.pathname + u.search : u.href;
      url = rebase ? base.replace(/\/$/, '') + u.pathname + u.search : u.href;
    } catch { continue; }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), headers: NAV_HEADERS, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) bad.push(`${path} declares ${shown} → ${res.status} to ${res.headers.get('location') ?? '?'}`);
      else if (res.status !== 200) bad.push(`${path} declares ${shown} → ${res.status}`);
    } catch (err) { bad.push(`${path} declares ${shown} → ${err.message}`); }
  }
  if (bad.length) {
    reporter.fix('seo', 'canonical:direct', `the canonical URL redirects or fails — ${bad.join('; ')}`,
      "serve the canonical form directly. Astro + @astrojs/cloudflare: set build.format: 'file' (about.html is served at /about; the adapter regenerates wrangler's assets block at build and drops html_handling, so that key cannot fix it) and strip .html where the page declares its own URL. A plain Workers static site: set assets.html_handling to match trailingSlash");
  } else {
    reporter.pass('seo', 'canonical:direct', `${declared.length} canonical URL(s) answer 200 with no redirect`);
  }
}

async function auditSeo(home, postPath, base, get, head, reporter) {
  assertHas(reporter, 'seo', 'home:canonical', home.text, /<link[^>]+rel=["']canonical["']/, 'homepage missing <link rel="canonical">');
  checkLdTypes(reporter, 'home:jsonld-website', home.text, (t) => t.has('WebSite'),
    'homepage emits no WebSite JSON-LD', 'emit a site-wide WebSite shape from the head component');
  checkHeadings(reporter, 'home', home.text);

  if (!postPath) {
    await checkCanonicalDirect([{ html: home.text, path: '/' }], base, reporter);
    // Name what didn't run. Two dogfood runs printed "audit clean — exit 0"
    // having skipped this whole block: silence read exactly like a pass.
    reporter.skip('seo', 'post', `no content page found in the sitemap, homepage links or /llms.txt — these did NOT run: ${POST_ONLY_CHECKS.join(', ')}. Pass --post <path> to audit a specific page`);
    return;
  }
  const postRes = await get(postPath);
  if (!postRes.ok || postRes.status !== 200) {
    // Naming the casualties matters most HERE. This path used to return in
    // silence, so a 404 on one URL voided thirteen checks and the run still
    // read as though the site had been audited.
    reporter.fix('seo', 'post', `${postPath} → ${postRes.status ?? postRes.error}; these did NOT run: ${POST_ONLY_CHECKS.join(', ')}`, 'pass --post <path> with a URL that answers 200', { url: postPath });
    return;
  }
  const h = postRes.text;
  await checkCanonicalDirect([{ html: home.text, path: '/' }, { html: h, path: postPath }], base, reporter);
  const checks = [
    ['title',        /<title>[^<]+<\/title>/,                              '<title> missing/empty'],
    ['description',  /<meta[^>]+name=["']description["'][^>]+content=["'][^"']+["']/, 'meta description missing'],
    ['canonical',    /<link[^>]+rel=["']canonical["']/,                    'canonical link missing'],
    ['og:title',     /<meta[^>]+property=["']og:title["']/,                'og:title missing'],
    ['og:image',     /<meta[^>]+property=["']og:image["']/,                'og:image missing'],
    ['og:image:width',  /<meta[^>]+property=["']og:image:width["']/,        'og:image:width missing', 'suggest'],
    ['og:image:height', /<meta[^>]+property=["']og:image:height["']/,       'og:image:height missing', 'suggest'],
    ['og:url',       /<meta[^>]+property=["']og:url["']/,                  'og:url missing'],
  ];
  for (const [name, re, msg, severity] of checks) {
    assertHas(reporter, 'seo', name, h, re, msg, severity);
  }
  checkHeadings(reporter, 'post', h);
  checkPostJsonLd(reporter, h, postPath);

  const ogImgRaw = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/)?.[1];
  if (ogImgRaw) {
    const ogImg = rebaseOnAudited(ogImgRaw, h, base);
    const r = await head(ogImg);
    const ct = r.headers?.get?.('content-type') || '';
    if (!(r.ok && r.status === 200 && /image\//.test(ct))) {
      reporter.fix('seo', 'og:image-resolves', `og:image → ${r.status ?? r.error} (${untrusted(ct || 'no content-type', 60)})`, 'the og:image URL must resolve to a real image', { url: ogImg });
    } else {
      reporter.pass('seo', 'og:image-resolves', untrusted(ct, 60), { url: ogImg });
      // 200 + image/* is necessary but not sufficient: a screenshot of a 404
      // page is *also* a valid 200 image/png (the bug this exists for: a 404 page served as a valid PNG).
      // Verify the served bytes are a real card by their intrinsic dimensions.
      await checkOgCard(ogImg, h, reporter, base);
    }
  }
}

/**
 * Point a self-hosted asset URL at the site being audited.
 *
 * og:image is built from the *production* siteUrl, so auditing localhost or a
 * staging deploy fetched production — or, on a site not yet live, nothing at
 * all, and the check could never pass. Rebasing only applies when the asset sits
 * on the page's own declared origin (its canonical/og:url): a genuine separate
 * media host (R2, a CDN) is fetched exactly as written, because that URL is what
 * a social scraper will really request.
 */
function rebaseOnAudited(assetUrl, html, base) {
  let asset, audited;
  try { audited = new URL(base); } catch { return assetUrl; }
  try { asset = new URL(assetUrl, base); } catch { return assetUrl; }
  if (asset.origin === audited.origin) return asset.href;

  const declared = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/)?.[1]
                ?? html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/)?.[1];
  let declaredOrigin = null;
  try { declaredOrigin = declared ? new URL(declared, base).origin : null; } catch {}
  if (declaredOrigin && asset.origin === declaredOrigin) {
    return new URL(asset.pathname + asset.search, audited.origin).href;
  }
  return asset.href;
}

// A resolvable og:image isn't proof it's a real card. A generator that screenshots
// an error page (e.g. requesting a no-trailing-slash URL on a trailingSlash:'always'
// site → 404) uploads a valid PNG that passes status + content-type — exactly how
// A real site shipped a 404 screenshot as a post's OG image. Verify the served bytes:
// they must clear the OG minimum (600×315 — below that platforms crop/reject) and
// match the dimensions the page declares. The same-viewport case (a 404 shot at the
// real 1200×630 viewport) can't be told apart from headers/bytes; preventing *that*
// is the generator's resp.ok() guard — a site-side fix (see BEST-PRACTICES § seo),
// not something the audit can catch from outside.
async function checkOgCard(ogImg, html, reporter, base) {
  if (!/\.(png|jpe?g|webp|avif)(\?|#|$)/i.test(new URL(ogImg, base).pathname)) {
    reporter.skip('seo', 'og:image:card', 'card is not one of the formats whose pixel size can be read from bytes (PNG/JPEG/WebP/AVIF) — the 600×315 minimum was NOT verified', { url: ogImg });
    return;
  }
  // A relative og:image used to throw inside fetchBytes and be swallowed, so the
  // check emitted no line at all — indistinguishable from "card is fine".
  const buf = await fetchBytes(absolutize(ogImg, base));
  const size = buf && imageSize(buf);
  if (!size) return; // unfetchable, truncated, or a container we can't read — leave the resolves pass standing
  const { w, h } = size;
  const declaredW = Number(html.match(/<meta[^>]+property=["']og:image:width["'][^>]+content=["'](\d+)["']/)?.[1]) || 0;
  const declaredH = Number(html.match(/<meta[^>]+property=["']og:image:height["'][^>]+content=["'](\d+)["']/)?.[1]) || 0;
  if (w < 600 || h < 315) {
    reporter.fix('seo', 'og:image:card', `served og:image is ${w}×${h} — below the 600×315 OG minimum (a placeholder, icon, or error-page screenshot, not a real card)`, 'serve a real ~1200×630 card; guard the generator with resp.ok() before it screenshots + uploads');
  } else if (declaredW && declaredH && (w !== declaredW || h !== declaredH)) {
    reporter.suggest('seo', 'og:image:dimensions', `served card is ${w}×${h} but og:image:width/height declare ${declaredW}×${declaredH}`, 'match the meta to the real card (or regenerate the card) so crawlers size it correctly');
  } else {
    reporter.pass('seo', 'og:image:card', `${w}×${h}`);
  }
}

// Fetch raw bytes for a resolved sub-resource (image), browser-shaped so a CDN
// doesn't bot-score the probe. Returns an ArrayBuffer, or null on any failure.
async function fetchBytes(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), headers: { ...BROWSER_BASE, Accept: 'image/*,*/*;q=0.8' }, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch { return null; }
}

// The stylesheets the audited pages load, as one out-of-flow selector set.
// Astro emits per-route sheets, so this is a handful of fetches; capped anyway
// so a page linking dozens cannot turn one domain into a crawl. A sheet that
// fails to fetch just isn't in the set — the check then behaves as it always did.
const MAX_STYLESHEETS = 6;

async function pageOutOfFlow(pages, get) {
  const css = [];
  const seen = new Set();
  for (const page of pages) {
    css.push(...inlineStyles(page.text));
    for (const href of stylesheetHrefs(page.text)) {
      const url = absolutize(href, page.url ?? href);
      if (seen.has(url) || seen.size >= MAX_STYLESHEETS) continue;
      seen.add(url);
      const r = await get(url, { headers: { Accept: 'text/css,*/*;q=0.1', 'Sec-Fetch-Dest': 'style', 'Sec-Fetch-Mode': 'no-cors' } });
      if (r.ok && r.status === 200) css.push(r.text);
    }
  }
  return outOfFlowSelectors(css);
}

// Images — content imgs routed + sized + under byte budget -------------------

async function auditImages(home, postPath, base, get, head, reporter) {
  const pages = [home];
  if (postPath) {
    const p = await get(postPath);
    if (p.ok && p.status === 200) pages.push(p);
  }

  const flow = await pageOutOfFlow(pages, get);

  const imgs = [];
  for (const page of pages) {
    const re = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    let m;
    while ((m = re.exec(page.text)) !== null) {
      const attrs = m[1];
      const src = attrValue(attrs, 'src');
      if (!src || isExempt(src)) continue;
      // Resolve against the page, not the site root: `images/x.png` on
      // /blog/hello/ is /blog/hello/images/x.png. Resolving against base gave a
      // wrong URL in the finding and a 404 that silently voided the byte check.
      imgs.push({ src: absolutize(src, page.url ?? base), attrs });
    }
  }

  if (imgs.length === 0) {
    // Name each one. A single "delivery: nothing to check" left routed/cls/alt
    // absent from the output entirely, which reads as though they passed.
    const why = 'no content <img> on the audited pages — nothing to check';
    for (const name of ['routed', 'cls', 'alt', 'bytes']) reporter.skip('images', name, why);
    return;
  }

  let routedOk = 0, sizedOk = 0, outOfFlow = 0, transformProbed = 0;
  const noQuality = [];
  const noAlt = [];
  const noSize = [];
  // A content image that does not answer 200, and a transform URL that answered
  // but was never transformed. Neither was visible before: the only thing read
  // off the response was content-length, and a 404 has none to exceed a budget.
  const dead = [];
  const notTransformed = [];
  const { shown: inspected, dropped } = capped(imgs, MAX_IMAGE_FINDINGS);
  if (dropped) {
    reporter.skip('images', 'delivery', `${imgs.length} content images found; inspecting the first ${MAX_IMAGE_FINDINGS}. ${dropped} not measured`);
  }
  for (const img of inspected) {
    // hasAttr, not a local regex: it accepts the bare `alt` that Astro emits for
    // alt="" (see html.mjs), so a decorative image isn't reported as missing alt.
    // Dedup by src so a templated image shared across pages counts once, matching
    // the dist-side alt check's unique-src semantics.
    if (!hasAttr(img.attrs, 'alt') && !noAlt.includes(img.src)) noAlt.push(img.src);

    // Two correct paths by provenance: Astro build-time optimization for local
    // assets (/_astro/…) and Cloudflare Image Transformations for R2 content.
    const optimized = /\/_astro\//.test(img.src);
    const routed = /\/cdn-cgi\/image\//.test(img.src);
    if (optimized || routed) routedOk++;
    else reporter.fix('images', 'routed', 'content image not optimized — neither Astro build (/_astro/) nor an image transform (/cdn-cgi/image/)', '<Image>/astro:assets for local assets; a /cdn-cgi/image/ URL for R2-hosted content', { url: img.src });

    // attrValue, not /\bwidth=/: \b matches inside `data-width=`, so a tag with
    // only data-attributes passed the CLS check. A value is required — a bare
    // `width` reserves no space.
    // An absolutely-positioned image is out of flow: it has nothing to shift,
    // and inset/height:100% override the ratio box the attributes would create.
    // Adding them to satisfy this check would be cargo cult — lib/css-flow.mjs
    // has the measurement that forced the carve-out. Collected, not reported one
    // by one: a shared component puts the same defect on every card on the page,
    // and 20 findings for one fix is what buries the other 1.
    const sized = attrValue(img.attrs, 'width') != null && attrValue(img.attrs, 'height') != null;
    if (sized) sizedOk++;
    else if (isOutOfFlow(img.attrs, flow)) outOfFlow++;
    else if (!noSize.includes(img.src)) noSize.push(img.src);

    // Transform-param anti-patterns, visible in the URL itself.
    const smells = transformSmells(img.src);
    if (smells?.explicitFormat) {
      reporter.fix('images', 'transform:format', `forces format=${smells.explicitFormat} not format=auto — no AVIF, and a raw-source fallback for clients that don't accept ${smells.explicitFormat}`, 'emit format=auto so Cloudflare negotiates AVIF/webp', { url: img.src });
    }
    if (smells?.missingQuality) noQuality.push(img.src);

    // Measure with a browser-realistic Accept so a format=auto transform
    // negotiates AVIF/webp — the bytes a real visitor downloads, not the raw source.
    const r = await head(img.src, { headers: { Accept: BROWSER_ACCEPT, 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' } });
    const isTransform = /\/cdn-cgi\/image\//.test(img.src);
    if (isTransform) transformProbed++;

    // Status, before anything is measured. `routed` reports the URL SHAPE, and a
    // shape is not a delivery: with Image Transformations switched off for the
    // zone every /cdn-cgi/image/ URL 404s, and this loop read a content-length
    // of 0 off it, compared 0 against the budget, and said nothing. A wholly
    // broken image lane reported ✅ routed and no findings.
    if (!r.ok || r.status !== 200) {
      dead.push({ src: img.src, why: r.ok ? `HTTP ${r.status}` : r.error, isTransform });
      continue;
    }

    // Answered 200 — but did Cloudflare actually transform it? Only the response
    // knows; see lib/cf-image.mjs for the measurement behind this.
    if (isTransform) {
      const verdict = transformApplied(r.headers, r.headers?.get?.('content-type') ?? '');
      if (!verdict.transformed) notTransformed.push({ src: img.src, why: verdict.why });
    }

    const len = Number(r.headers?.get?.('content-length') ?? 0);
    if (len > 300 * 1024) {
      reporter.fix('images', 'bytes', `${(len / 1024).toFixed(0)} KB served — over 300 KB budget`, 'lower the transform width=/use format=auto + quality=80; a hero should be 50–250 KB', { url: img.src });
    }
  }
  const sampled = `on ${pages.length === 1 ? 'the homepage only' : `${pages.length} pages`}`;
  if (routedOk === inspected.length) reporter.pass('images', 'routed', `${routedOk}/${inspected.length} through an image transform, ${sampled}`);
  const flowAside = outOfFlow ? ` (${outOfFlow} absolutely positioned — out of flow, nothing to shift)` : '';
  if (noSize.length === 0) reporter.pass('images', 'cls', `${sizedOk}/${inspected.length} have width+height${flowAside}, ${sampled}`);
  else reporter.fix('images', 'cls', `${noSize.length} content <img> carry no width/height → layout shift (CLS)${flowAside}`, 'use <Image> (bakes dimensions) or add width+height', { url: noSize[0] });
  if (noAlt.length === 0) reporter.pass('images', 'alt', `${inspected.length}/${inspected.length} carry an alt attribute, ${sampled}`);
  else reporter.fix('images', 'alt', `${noAlt.length} content <img> have no alt attribute`, 'add alt text (alt="" only if decorative)', { url: noAlt[0] });
  if (noQuality.length) reporter.suggest('images', 'transform:quality', `${noQuality.length} transform URL(s) set no quality= (Cloudflare defaults to 85)`, 'add an explicit quality (e.g. quality=80) to cap output size on photographic content', { url: noQuality[0] });

  // Does the image the page asks for actually exist? Universal — a content image
  // that 404s is broken on anyone's site, whatever delivers it.
  if (dead.length === 0) {
    reporter.pass('images', 'resolves', `all ${inspected.length} content image(s) answer 200, ${sampled}`);
  } else {
    const tx = dead.filter((d) => d.isTransform).length;
    // Naming the pattern is the whole value: N dead transform URLs is not N
    // broken images, it is one switch in a dashboard.
    const hint = tx === dead.length
      ? ' — and every one is a /cdn-cgi/image/ URL, which is what a zone with Image Transformations not enabled looks like'
      : '';
    reporter.fix('images', 'resolves', `${dead.length}/${inspected.length} content image(s) do not answer 200 (${dead[0].why})${hint}`,
      tx === dead.length
        ? 'enable Image Transformations for this zone (Cloudflare dashboard → Images → Transformations → select the zone), or stop emitting /cdn-cgi/image/ URLs'
        : 'the page requests an image the server does not serve — fix the URL or ship the file',
      { url: dead[0].src });
  }

  // And if it exists, was it transformed? A transform URL that serves the
  // original is the expensive silent case: it looks optimized in the HTML, in
  // dist/, and to every offline check here.
  if (transformProbed === 0) {
    reporter.skip('images', 'transform:applied', 'no /cdn-cgi/image/ URLs among the images audited — nothing whose transform could be verified');
  } else if (notTransformed.length === 0) {
    reporter.pass('images', 'transform:applied', `all ${transformProbed} transform URL(s) came back with a cf-resized header — Cloudflare is really transforming them`);
  } else {
    reporter.fix('images', 'transform:applied', `${notTransformed.length}/${transformProbed} /cdn-cgi/image/ URL(s) answered 200 but were NOT transformed — ${notTransformed[0].why}`,
      'enable Image Transformations for this zone (Cloudflare dashboard → Images → Transformations), and check the source origin is on the allowed list; until then these URLs serve the untransformed original',
      { url: notTransformed[0].src });
  }
}

// Data — machine-readable endpoints ------------------------------------------

async function auditData(get, reporter) {
  const r = await get('/llms.txt');
  if (!r.ok || r.status !== 200) {
    reporter.fix('data', 'llms.txt', `/llms.txt → ${r.status ?? r.error}`, 'add a src/pages/llms.txt.ts endpoint built from getCollection()');
    return;
  }
  reporter.pass('data', 'llms.txt:served', '200');
  assertHas(reporter, 'data', 'llms.txt:h1', r.text, /^#\s+\S/m, '/llms.txt has no H1');
  const grouped = /^##\s+\S/m.test(r.text);
  const indexed = /llms-[a-z]{2}\.txt/.test(r.text);
  if (grouped || indexed) reporter.pass('data', 'llms.txt:structure', grouped ? 'grouped by type' : 'index → per-locale');
  else reporter.fix('data', 'llms.txt:structure', 'no ## section groups and no per-locale links', 'group entries by type/section');
}

// Helpers --------------------------------------------------------------------

function mkGet(base) {
  return async function get(path, { headers } = {}) {
    const url = path.startsWith('http') ? path : base + path;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), headers: { ...NAV_HEADERS, ...headers }, redirect: 'follow' });
      const text = await res.text();
      return { ok: true, status: res.status, headers: res.headers, text, url };
    } catch (err) {
      return { ok: false, error: err.message, url };
    }
  };
}

function mkHead(base) {
  return async function head(path, { headers } = {}) {
    const url = path.startsWith('http') ? path : base + path;
    const h = { ...BROWSER_BASE, ...headers };
    try {
      let res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), method: 'HEAD', headers: h, redirect: 'follow' });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), headers: { ...h, Range: 'bytes=0-0' }, redirect: 'follow' });
      }
      return { ok: true, status: res.status, headers: res.headers, url };
    } catch (err) {
      return { ok: false, error: err.message, url };
    }
  };
}

function assertHas(reporter, section, name, html, re, failMsg, severity = 'fix') {
  if (re.test(html)) reporter.pass(section, name);
  else if (severity === 'suggest') reporter.suggest(section, name, failMsg, 'emit it in the rendered HTML — platforms lay the card out before fetching it');
  else reporter.fix(section, name, failMsg, 'emit it in the rendered HTML');
}

// Parse the JSON-LD rather than substring-matching it: a page emitting Article
// where we looked for the literal "BlogPosting" was reported as having none, and
// a @graph-wrapped shape was invisible to the regex either way.
/**
 * The sampled content page describes what it is.
 *
 * An Article-family type is the common answer and the one the baseline wants for
 * posts. It is not the only correct one: a glossary entry is a `DefinedTerm`, an
 * FAQ is an `FAQPage`, and rewriting either as an Article would make the page
 * worse. Both pass; the message says which was found, so "this is a definition"
 * and "this is a post" stay distinguishable in the output.
 *
 * Only a page carrying neither — nothing but `WebPage`/`WebSite` wrappers, or no
 * JSON-LD at all — is a finding.
 */
function checkPostJsonLd(reporter, html, postPath) {
  const { objects } = collectJsonLd(html);
  const types = ldTypes(objects);
  const shown = untrusted([...types].sort().join(', '), 160);
  const at = { url: postPath };
  const { kind, type } = classifyPage(types);

  if (kind === 'article') {
    reporter.pass('data', 'post:jsonld', shown, at);
  } else if (kind === 'content') {
    reporter.pass('data', 'post:jsonld', `${shown} — ${type} is this page's own content type, not a missing Article`, at);
  } else {
    reporter.fix(
      'data',
      'post:jsonld',
      `content page emits no type saying what it is (Article/BlogPosting/… or DefinedTerm/FAQPage/HowTo/…)${types.size ? ` — found: ${shown}` : ''}`,
      'emit an Article-family shape per post, or the type that actually describes the page',
      at,
    );
  }
}

function checkLdTypes(reporter, name, html, predicate, failMsg, fixMsg, at = {}) {
  const { objects } = collectJsonLd(html);
  const types = ldTypes(objects);
  const shown = untrusted([...types].sort().join(', '), 160);
  if (predicate(types)) reporter.pass('data', name, shown, at);
  else reporter.fix('data', name, `${failMsg}${types.size ? ` — found: ${shown}` : ''}`, fixMsg, at);
}

// `label` is which page was read (home / a content path). It's the location of
// the finding, not a different rule — so it rides in `url`, and both pages
// report under one stable id.
function checkHeadings(reporter, label, html) {
  const a = headingAudit(headingLevels(html));
  const at = { url: label };
  if (!a.h1) reporter.pass('seo', 'headings:h1', 'exactly one <h1>', at);
  else reporter.fix('seo', 'headings:h1', a.h1, 'exactly one <h1> per page (the title)', at);
  if (!a.skip) reporter.pass('seo', 'headings:order', 'no skipped levels', at);
  else reporter.suggest('seo', 'headings:order', a.skip, 'keep the outline sequential; a shared header/footer level is the usual cause', at);
}

function firstHashedAsset(html) {
  const m = html.match(/["'(]([^"'()]*\/_astro\/[^"'()]+\.(?:js|css))["')]/);
  return m ? m[1] : null;
}

// Routes that exist on nearly every site and are not the content page we want
// to audit. Matched on the whole path, lowercased.
const INDEX_ROUTES = new Set([
  '/', '/about', '/contact', '/blog', '/posts', '/articles', '/notes', '/writing',
  '/projects', '/work', '/wiki', '/docs', '/search', '/tags', '/categories',
  '/archive', '/now', '/uses', '/privacy', '/terms', '/imprint', '/legal',
  '/404', '/rss', '/feed', '/sitemap',
]);
const NON_PAGE_EXT = /\.(xml|json|txt|rss|atom|png|jpe?g|webp|avif|gif|svg|ico|pdf|css|js|mjs|zip)$/i;
// /blog/2, /page/3 — pagination, same template as its index.
const PAGINATION = /\/(?:page\/)?\d+\/?$/;

/**
 * Find a content page to audit.
 *
 * This used to match `href="…/blog/…"` and nothing else. Every one of five
 * dogfood sites used /projects/ and /wiki/ instead, so around ten live checks
 * silently never ran and two runs printed "audit clean, exit 0" having checked
 * almost nothing. Forcing --post turned one of them into four findings.
 *
 * Order matters: the sitemap is the site's own declaration of its content URLs,
 * so it beats guessing from markup. Homepage links are the fallback, /llms.txt
 * the last resort.
 */
async function discoverPost(home, base, get) {
  // The feed first: it is the site's own list of what it considers an article,
  // so it answers the question the post-only checks are actually asking. The
  // sitemap lists every indexable page equally, and "deepest path wins" then
  // picks whatever sorts first — on the site that reported this it was
  // /glossary/agent/, a DefinedTerm page, while the BlogPosting-carrying
  // /projects/* sat right next to it (issue #11, 2026-08-03).
  const fromFeed = await feedCandidates(base, get);
  const feedPick = pickContentPath(fromFeed, base);
  if (feedPick) return feedPick;

  const fromSitemap = await sitemapCandidates(base, get);
  const best = pickContentPath(fromSitemap, base);
  if (best) return best;

  // Anchors only. A bare href= scan also picks up <link rel="canonical">, so a
  // page pointing at itself "discovered" itself and the audit read one page twice.
  const links = [...home.text.matchAll(/<a\b[^>]*?\shref=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const fromLinks = pickContentPath(links, base);
  if (fromLinks) return fromLinks;

  const r = await get('/llms.txt');
  if (!r.ok) return null;
  return pickContentPath([...r.text.matchAll(/\]\((\S+?)\)/g)].map((m) => m[1]), base);
}

/**
 * A site with `trailingSlash: 'always'` (or 'never') answers on exactly one
 * form. Try the other before letting a slash abandon thirteen checks.
 */
async function resolveSlash(path, get) {
  if (!path) return path;
  const first = await get(path);
  if (first.ok && first.status === 200) return path;
  const flipped = path.endsWith('/') ? (path.replace(/\/+$/, '') || '/') : path + '/';
  if (flipped === path) return path;
  const alt = await get(flipped);
  return (alt.ok && alt.status === 200) ? flipped : path;
}

/**
 * Item URLs from the site's feed, in feed order (newest first, conventionally).
 *
 * RSS puts them in `<item><link>`, Atom in `<entry><link href=…>`. Both are read
 * because a site ships whichever its generator emits, and @astrojs/rss can be
 * pointed at any filename.
 */
async function feedCandidates(base, get) {
  for (const path of ['/rss.xml', '/feed.xml', '/atom.xml', '/rss', '/feed', '/index.xml']) {
    const r = await get(path);
    if (!r.ok || r.status !== 200 || !/<(?:rss|feed)\b/i.test(r.text)) continue;
    const rss = [...r.text.matchAll(/<link>\s*([^<\s]+)\s*<\/link>/gi)].map((m) => m[1]);
    const atom = [...r.text.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)].map((m) => m[1]);
    const urls = [...rss, ...atom];
    if (urls.length) return urls;
  }
  return [];
}

async function sitemapCandidates(base, get) {
  const out = [];
  for (const entry of ['/sitemap-index.xml', '/sitemap.xml', '/sitemap-0.xml']) {
    const r = await get(entry);
    if (!r.ok || r.status !== 200 || !/<(?:urlset|sitemapindex)/i.test(r.text)) continue;
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    // An index lists other sitemaps; follow a bounded number of them.
    if (/<sitemapindex/i.test(r.text)) {
      for (const child of locs.slice(0, 3)) {
        const c = await get(child);
        if (c.ok && c.status === 200) out.push(...[...c.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
      }
    } else {
      out.push(...locs);
    }
    if (out.length) break;
  }
  return out;
}

/**
 * The most content-shaped path in a list of URLs. Deeper paths win: /blog/x or
 * /wiki/y is a leaf, /blog is its index. Same-origin only — an outbound link is
 * not this site's content.
 */
function pickContentPath(urls, base) {
  const origin = new URL(base).origin;
  const paths = [];
  for (const u of urls) {
    let path;
    try {
      const abs = new URL(u, base);
      if (abs.origin !== origin) continue;
      // Keep the trailing slash EXACTLY as the site declared it. Normalising it
      // away requested /wiki/x on a `trailingSlash: 'always'` site, which 404s —
      // the sitemap had just told us the canonical form and we discarded it.
      path = abs.pathname || '/';
    } catch { continue; }
    const bare = path.replace(/\/+$/, '') || '/';
    if (NON_PAGE_EXT.test(bare)) continue;
    if (INDEX_ROUTES.has(bare.toLowerCase())) continue;
    if (PAGINATION.test(bare)) continue;
    // A single leading segment that is itself an index route ("/blog/tag/x")
    // still counts as content; a bare "/tag/x" listing does not.
    if (/^\/(?:tags?|categor(?:y|ies)|author)\//i.test(bare)) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  if (!paths.length) return null;
  // Deepest first, then shortest — a leaf article over a section landing page.
  paths.sort((a, b) => depth(b) - depth(a) || a.length - b.length);
  return paths[0];
}

function depth(path) {
  return path.split('/').filter(Boolean).length;
}

function isExempt(src) {
  return /\.(svg|ico)(\?|$)|\bfavicon\b/i.test(src) || src.startsWith('data:') || src.startsWith('blob:');
}

function absolutize(src, base) {
  try { return new URL(src, base).href; }
  catch { return src; }
}

