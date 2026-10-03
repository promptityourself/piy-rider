# rider tools

The engine behind `/piy-rider:audit`. Detects an Astro project, runs domain checks, reports `✅ / 🔧 / 🛑 / 💡 / ⏭`, exits non-zero on findings. Zero dependencies — Node 22 built-ins only.

**The check set moves faster than this page.** `--rules --json` is the authoritative
list of what the tool checks and which of it binds you — it is generated from the code,
so it cannot drift. The table below is orientation, not an inventory.

## Usage

```bash
cd ~/projects/<some-astro-site>
rider=~/projects/piy-rider/tools/audit.mjs   # the path is rider's, the cwd is the site's

node $rider            # every offline domain
node $rider -s seo -s images   # subset
node $rider --url https://example.com # add live checks
node $rider --url … --post /blog/x     # audit that page, not a discovered one
node $rider --url … --strategy desktop # Lighthouse + browser at desktop width (default: mobile)
node $rider --strict    # require the house-style baseline too
node $rider --json     # machine-readable
node $rider --quiet    # hide ✅ lines; findings, 💡 and ⏭ still print
node $rider --verbose  # show ✅ even when piped or under $CI
node $rider --dry-run  # the exact changes --fix would make; writes nothing
node $rider --fix      # apply them, then re-audit to prove each one worked
node $rider --report audit.html  # also write the run as a shareable HTML page
node $rider --rules --json  # every rule id, severity, mode and why; runs nothing
node $rider --help
```

## Domains

| Domain | Checks |
|---|---|
| `modules` | Astro 7+, Node ≥ 22.12, TypeScript ≤ 6.x, baseline integrations, `output: 'static'`, strict TS (and a `tsconfig` `exclude` that still excludes `dist`), `compressHTML`, `<ClientRouter>`, custom 404, self-hosted fonts, at most one search engine, an adapter iff a route renders on demand (plus the Cloudflare-specific `imageService` call), remotePatterns (if og.config declares a media domain), Astro 7 migration residue (`astro7:experimental`, `astro7:markdown`, `astro7:db`, `astro7:transitions`); a 404 the host is configured to serve (`404:served`) |
| `seo` | Head meta emitted — `<title>`, description, OG, canonical — over the pages the sitemap declares (asserted against `dist/` when built, source otherwise); no `keywords` anti-pattern; a canonical that is not shared site-wide; `dist/robots.txt` with an absolute `Sitemap:` URL; the sitemap read against Google's rules (absolute URLs, the 50k/50MB caps, W3C-datetime `<lastmod>`, ignored `changefreq`/`priority`) and cross-checked against the pages it declares (`noindex`, robots.txt `Disallow`, a canonical pointing elsewhere); hreflang alternates on a multi-locale site; `<html lang>`, one absolute canonical and one document `<title>` per page, internal links that resolve, orphan pages, duplicate titles/descriptions, indexable pages absent from the sitemap, and a site-wide robots.txt block; one `<h1>` per content page (a skipped level is advisory); a viewport meta; a favicon in a format Google reads (SVG is not one) and square; hreflang alternates that are absolute, self-listing, reciprocal and use a tag Google parses; robots-meta directives Google implements, and never a `noindex` on a URL robots.txt forbids; generic link text (advisory); brand fields (if og.config present) |
| `images` | `<img>` + CSS `background-image` routed through an image transform, and no background pinned to one width; no oversized raster in `src/assets/`; no oversized built image in `dist/` (a `srcset` judged as a ladder, by its smallest rung); `alt` on every content `<img>`; transform params (`format=auto`, an explicit `quality=`); a large image shipping one fixed width with no `srcset` at all; live, that the transform actually ran (`cf-resized`) and that every content image resolves — a per-zone toggle being off looks identical in the HTML |
| `perf` | `public/_headers` marks `/_astro/*` immutable; content `<img>` carry width/height (CLS) unless CSS takes them out of flow; render-blocking CSS on the heaviest page and total webfont weight stay inside budget; woff2 not ttf/otf; every declared font family leads a stack and sets `styles`; a heavy third-party embed sits behind a facade; a cross-origin image host gets `preconnect` (with `crossorigin`) and a `preload` matching its `<img>` |
| `content` | A media-kit page (logo, paste-ready boilerplate, a contact route) and a design/styleguide page that renders the real tokens. Both house style — `💡` unless `--strict` |
| `analytics` | What delivers analytics (Cloudflare Web Analytics by default; Zaraz when you need a tag manager) — advisory, never a finding. Plus a hardcoded GA/GTM snippet in `src/` + `dist/`, which fires before consent |
| `data` | JSON-LD parsed out of `dist/` (an Article-family type + `WebSite`, and it must be valid JSON); `/llms.txt` from `getCollection()` with a draft/preview filter; the built RSS feed has items; a search-index endpoint when the engine needs one; Zod-validated content schema |
| `live` | Only with `--url`: real Cache-Control, served image bytes, rendered SEO + JSON-LD, `/llms.txt`. The content page is discovered from the sitemap → homepage links → `/llms.txt`, or forced with `--post` |
| `lighthouse` | Only with `--url`: measured PageSpeed Insights scores (perf/seo/a11y/best-practices) + Core Web Vitals. Needs a PSI key (see below); skips without one |
| `project` | Not `-s`-selectable — the gate ahead of every other domain: whether `dist/` is older than the source it was built from (`dist:stale`). Each check below that reads `dist/` is judging a build, and a stale one is a different site |
| `browser` | Only with `--url`: what a real browser sees — uncaught JS errors, failed/404 sub-requests, measured CLS, images far larger than their rendered box, heavy third-party origins, nav links still reachable at phone width. Needs `playwright` installed; skips cleanly without it |

It **assumes a baseline stack** and validates compliance — it does not set anything up.

"The baseline" throughout these docs means: Astro 7+, `output: 'static'`, Cloudflare
delivery (Image Transformations, immutable hashed assets) and Cloudflare Web
Analytics. Search is optional. Checks that only make sense on that stack report as
`💡 [baseline]` by default and are required only under `--strict` — so a site built
differently still gets useful answers. See `../BEST-PRACTICES.md`.

## Lighthouse key resolution

The `lighthouse` domain calls the PageSpeed Insights API and needs a free key: set
`$PAGESPEED_API_KEY`. That environment variable is the only secret the tool reads, and
the only place it talks to an external API.

No key → the domain `⏭ skips` (everything else still runs). Score → outcome: `≥90 ✅`, `50–89 💡`, `<50 🔧`. Transient PSI `500`s get up to 3 attempts (2 retries).

## Outcomes

```
✅  pass      compliant
🔧  fix       mechanically fixable (required)
🛑  block     needs a decision (required)
💡  suggest   optional / nice-to-have (advisory)
⏭   skip      not run / not testable here
```

Exit: `0` clean (💡 suggestions don't count) · `1` findings (🔧/🛑) · `2` tooling error.

## Reading `--json`

`id` identifies the **rule**, not the row. One rule fires as many times as it
finds something — five `modules/dep` rows, one `images/alt` row per offending
page — so `id` is what you filter, suppress and report by, and it is stable
across releases. An individual finding is `(id, source, file/line or url)`;
`name` carries the subject (`dep:@astrojs/rss`) and is for humans.

`file`/`line`/`url` appear only when the finding has a location: a project-level
check like `modules:engines.node` has none, and an empty field would be noise.
`source` is `offline` or `live`, which is how the two `images:alt` rows — one
reading `dist/`, one reading served HTML — stay apart in a combined run.

## Files

```
tools/
  audit.mjs              entry — arg parsing, project detection, domain dispatch
  brief.mjs              read a pasted design brief: the plan it implies, and the
                         content it names, fetched and checked before a page sees it
  lib/
    project.mjs          cwd → Astro-project detection + config/source loading
    policy.mjs           universal vs house-style vs advisory (drives --strict)
    image-size.mjs       PNG/JPEG/WebP/AVIF intrinsic dimensions from raw bytes
    src-scan.mjs         read src/ once; find head-meta by behaviour, not filename
    reporter.mjs         outcome collection, human/JSON output, exit code
    rules.mjs            the rule catalogue behind --rules --json
    untrusted.mjs        fence bytes fetched from an audited site before printing
    brief.mjs            a pasted brief, read as data — shape, not who wrote it
    cf-image.mjs         Cloudflare transform-URL param parsing (shared offline + live)
    html.mjs             dist/served HTML scanning — headings, alt text, srcset, content-page gate
    css-flow.mjs         which elements CSS takes out of flow (so CLS checks don't false-fire)
    remedy.mjs           the machine-applicable half of a finding (copy/json/edit) + apply
    fixer.mjs            --fix: apply, re-audit, revert the set if anything regressed
    dist.mjs             read the build output (find + read files under dist/)
    headers.mjs          parse public/_headers into rules the cache checks can ask
    jsonld.mjs           parse the JSON-LD a page emits; Article-family types
    fonts-config.mjs     the Astro Fonts API config, as declared families
    report-html.mjs      --report: the run as a standalone brand-designed page
    walk.mjs             one directory traversal — was eight open-coded copies
    text.mjs             truncate() for finding messages — was five identical copies
    config-string.mjs    one reader for a string value in config TEXT — the quoted-value
                         regex lived in four places and all four dropped a value carrying
                         the other quote (`tagline: "Australia's …"` read as absent)
    analytics-signals.mjs  what a beacon/tag-manager/GA snippet looks like
    embed-hosts.mjs      which third-party iframe hosts are heavy enough to need a facade
    search-engines.mjs   search engines as package FAMILIES, and which read a site-emitted index
  checks/
    modules.mjs          baseline stack
    seo.mjs              discoverability meta
    images.mjs           image delivery + sizes (source + dist)
    perf.mjs             cache headers + CLS
    data.mjs             JSON-LD, llms.txt, RSS, content schema
    content.mjs          media-kit + design reference pages
    analytics.mjs        what delivers analytics + no pre-consent GA/GTM snippet
    live.mjs             HTTP checks against a served site (--url)
    lighthouse.mjs       measured PSI scores + Core Web Vitals (--url + key)
    browser.mjs          real-Chromium runtime checks (--url + playwright)
  test.mjs               the offline half of the gate — `node tools/test.mjs`, exit 0 = ok
  verify-example.mjs     the live half — builds an example, serves it, audits it with --url
```
