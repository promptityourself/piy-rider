# Best practices

This is the *why* behind every check the audit runs. The governing rule:

> **Every best practice here has an enforcing check.** If we believe something,
> the tool proves it on every run. A practice with no check is a *gap* (tracked
> at the bottom) — not a best practice yet.

So this doc and `tools/checks/*` move together: you don't add a practice without
baking a test, and you don't add a test without writing down why. Real sites being audited are the source of new practices — each problem worth
preventing everywhere becomes a permanent check.

**Baseline assumed.** The baseline Astro stack: Astro 7+, `output: 'static'`,
Cloudflare delivery (Image Transformations for R2 content, immutable hashed
assets), and Cloudflare Web Analytics for measurement. The tool validates
compliance against this — it never sets anything up or migrates.

Two things left the baseline on **2026-08-03**, because both had become a wall
between a new site and a working one:

- **Search is optional.** It used to be a required dependency (`@orama/orama`),
  so a site that had deliberately shipped no search collected a finding for it.
  What binds now is coherence, not presence — see *Search* under `modules`.
- **Analytics is Cloudflare Web Analytics by default, not Zaraz.** Web Analytics
  is free, cookieless and needs no consent banner, so a site can be measured the
  day it deploys. Zaraz remains fully supported and fully documented below; it is
  the right answer when you need a tag *manager*, and it is a dashboard project
  before it is anything else. Nothing about analytics fails a run in either mode.

**Own it before you buy it (2026-09-02).** The baseline favours Cloudflare's own
services and the platform's own primitives over a third-party library or SaaS,
and this tool never *offers* a third party unless the user asks for one by name.
The starter is the existence proof: the contact form is a typed endpoint on
Cloudflare Email Service, not a form vendor; the type is a system stack, so there
is no font CDN and no webfont payload at all; measurement is Web Analytics, not
a tag; social cards
are drawn at build time, not fetched from a card service. For the small business
this stack is built for, a typed form is easier to write than a product is to
buy, integrate and pay for, and it is enough. The checks still *recognise*
third-party engines and hosts — a validator has to know what a site uses — but
recognising is not recommending, and the distinction is the whole rule.

**Severities.** 🔧 fix = required, fails the run · 🛑 = needs a human decision ·
💡 = advisory suggestion, never fails · ⏭ = not testable in this mode.

**Modes.** Every rule in the catalogue also carries `mode`: `offline` (reads
source and `dist/`) or `url` (needs a served site). **A large minority are
`url`** — the `live`, `lighthouse` and `browser` domains entirely, plus the
served-HTML twins of offline checks, which is why `meta:og:image` and `og:image` are two rule
ids for one practice measured in two places. That is deliberate, not
duplication: served HTML is not always the built HTML, and the analytics domain
depends on the difference. What was *not* deliberate is that until 2026-09-01 the
only thing recording it was the phrase "Live only:" in a `why` string — fine for
a human, useless to the agent the catalogue exists for. It is a field now,
derived from the section plus that convention, with `tools/test.mjs` enforcing
the convention rather than trusting it.

**A catalogue entry nothing emits is a lie in the catalogue.** `--rules` is this
tool's answer to "what do you check", so a row with no check behind it is worse
than a missing row. `images/optimized` was one for months: the check was renamed
to `images: routed` and the entry stayed, because the suite asserted *emitted ⊆
catalogued* and never the reverse. Both directions are asserted now, with a
planted dead rule used to prove the detector fires rather than passing vacuously.

**Universal vs house style.** Not every practice here binds every Astro site.
A check is **universal** when ignoring it means a real defect — a broken build, a
measurable performance or accessibility problem, or missing SEO fundamentals
every crawler and social preview depends on. It's **house style** when a
reasonable site could make a different call and still be well built: which search
library, which host's cache-header file, whether there's an RSS or `llms.txt`
endpoint at all.

By default only universal checks are required; house-style ones report as
`💡 … [baseline]` and don't fail the run. `--strict` requires everything, which
is the right mode once you've adopted the baseline deliberately. The
classification is one table in `tools/lib/policy.mjs` — **when you add a
practice, classify it there too**, or it silently defaults to universal and
starts failing strangers' builds.

There is a third, much smaller category: **advisory**. A handful of checks report
a *fact* rather than a verdict and have no `🔧`/`🛑` branch at all — `--strict`
does not promote them because there is nothing to promote. `analytics: provider`
is the one that matters. They are listed separately in `policy.mjs` so
`--rules` can label them `[advisory]` instead of `[universal]`, which would read
as "required by default".

## How we add a practice

When an audited site hits a problem worth preventing everywhere:

1. **Understand the requirement.** Read the underlying integration/service docs
   via `context7` (Astro, Cloudflare, the relevant plugin) — encode the real
   contract, not a guess. This is a hard rule for Astro/Cloudflare specifics.
2. **Write the practice here** — what it is and *why* (the failure it prevents).
3. **Bake the check** into `tools/checks/<domain>.mjs`. Reuse `tools/lib/`
   helpers; keep detection precise so it doesn't false-positive on a legitimate
   variant (e.g. per-locale naming, a factored predicate helper).
3b. **Classify it** in `tools/lib/policy.mjs` — universal practice, or this
   project's house style? Unclassified means universal, which means it fails the
   build of every stranger who doesn't share the opinion. Ask: could a
   well-built Astro site reasonably do this differently?
4. **Verify.** `node ../../tools/audit.mjs` in **both** `examples/_fixture-i18n/` and
   `examples/starter/` must stay
   `0 🔧 / 0 🛑` (in both default and `--strict`), and run it against at least one real site (drift there is expected and
   informational — it's how we confirm the check fires on the wild case).
5. **Ship it.** The check is now permanent.

Detection should accept *correct variants*, not just one spelling. The two
worst things a check can do are miss a real violation and flag a compliant site;
both erode trust in the tool, so a new practice isn't done until it's been run
against a known-good site and a known-bad one.

**Every outcome names its evidence — passes included.** `✅ seo: no-keywords`
with nothing after it is indistinguishable from a check that ran over zero files
and reported success, which is this tool's worst failure mode wearing a tick.
Say what was looked at and how much of it (`not emitted by any of the 23 source
file(s) under src/`). `tools/test.mjs` asserts this as an invariant over the
whole fixture run, so a new check cannot quietly reintroduce a mute pass.

---

## project — is the audit judging the site you think it is

*Emitted by `tools/audit.mjs` itself, before any domain runs.*

- **`dist/` is newer than the source it was built from.** Every check in `images`,
  `seo`, `data` and half of `perf` reads the build, so a build the source has
  moved past is a different site. This exists because the audit once reported
  `62 ✅ 0 🔧` on a site whose build was **broken**: an over-length `excerpt`
  failed the content schema, `astro build` died, and the audit happily read the
  `dist/` the previous good build had left behind. Nothing in the output hinted
  that the two disagreed.

  **A required finding, deliberately** (owner's call, 2026-09-03). It is tempting
  to make it a `⏭`, since what it reports is a defect in the audit's *inputs*
  rather than in the site — but the whole failure it exists for is a run that
  read as clean, and a skip is quieter than the thing it is warning about.

  Two guards against crying wolf, both learned the same day. It allows a **2s
  grace window**, because `git clone`, `git checkout` and `git stash pop` stamp
  source and build at effectively the same instant and a strict comparison then
  picked a winner from sub-millisecond ordering. And when either walk exceeds its
  budget it reports that it **could not tell**, rather than guessing — truncation
  can only ever bias the answer toward "stale". It is also scoped: a `--url`-only
  run reads no `dist/`, so it says nothing.
  → `project: dist:stale`

## modules — the baseline stack is present and wired

*Check file: `tools/checks/modules.mjs`. Source: `package.json`, `astro.config.*`,
`tsconfig.json`.*

- **Astro 7+.** Baseline features (content layer, `astro:assets`, current config
  shape) assume a modern Astro, and v7 is where the stack now sits: the Rust
  compiler, the Sätteri markdown pipeline, and Vite 8. Staying on 6.x means
  running a superseded compiler and markdown pipeline, and the v7-only config
  surface below can't be relied on. → `modules: astro:version`
  *(Baseline moved 6.3 → 7 on 2026-08-01; Astro 7.0 shipped 2026. Migration
  guide: `docs.astro.build/en/guides/upgrade-to/v7`.)*

  **The examples declare `^7.2.6`, not `^7`, since 2026-09-01** — not a new
  check (`astro:version` still only asks for major 7), but the floor
  `@astrojs/mdx@8` peers on. Astro 7.2.10 pins `@astrojs/markdown-satteri@0.4.0`,
  which is the other half of that peer, so the two move together or not at all.
  Deliberately *not* restated as a number anywhere else: `npm view astro version`
  is the current release and this sentence would be stale the week after it was
  written — as the line it replaced was.
- **Node ≥ 22.12.0.** Astro 7's own `engines.node` floor — a lower declared
  floor lets a build land on a runtime Astro won't start on. →
  `modules: engines.node`
- **TypeScript ≤ 6.x while `@astrojs/check` is installed.** TS 7 is published as
  npm `latest`, but `@astrojs/check` peers on `typescript ^5 || ^6` — installing
  TS 7 breaks `astro check`, which is the type gate the baseline relies on. Pin
  `^6` until the peer range widens. → `modules: typescript:version`
- **Baseline integrations installed:** `@astrojs/mdx`, `@astrojs/sitemap`,
  `@astrojs/rss`, `@astrojs/check`. Each backs a downstream practice (RSS feed,
  sitemap, type-checking). → `modules: dep:<name>`

  ⚠ **An installed integration is not a working one, and `@astrojs/mdx` was
  neither example's for as long as both existed.** Both content loaders globbed
  `'**/*.md'`, so an `.mdx` post produced no page and no error — the audit
  required the dependency of every site it ran on while its own two reference
  sites could not have used it. Fixed on 2026-09-01: the pattern is
  `'**/*.{md,mdx}'`, `generateId` strips either extension, and the fixture now
  carries one genuine `.mdx` post whose exported expression is evaluated at
  build time, so a regression stops the build rather than passing quietly.
  This is the same shape as the search checks — *presence* is cheap to assert
  and worth almost nothing next to *coherence*. → `modules: mdx:reachable`

  The check reads every `pattern:` in `content.config.ts` and asks one question:
  **can MDX be loaded anywhere?** Not "does every collection take it" — a site
  may quite reasonably let only one collection hold MDX, and a pattern *array*
  is one loader matching any of its globs. Conflating those two unions was the
  check's first bug, and it fired on a correct site: `['**/*.md', '**/*.mdx']`
  reported as excluding `.mdx` because its first element does.

  A pattern that is not a string literal — a variable, a spread, something built
  at runtime — is reported as **unread**, not guessed at. An unreadable pattern
  is a missed finding; a guessed one is a wrong finding on a site that is fine,
  and this file's whole bias is that the second costs more.

  `astro-robots-txt` was on this list and no longer is. The practice is that the
  build *ships* a robots.txt pointing at the sitemap — a generated endpoint does
  that at least as well as the package, and collides with it if you have both.
  Requiring the package tested our habit, not the outcome. → `seo: robots`

  `@orama/orama` left the list on 2026-08-03 for a different reason: it was
  requiring a *feature*, not an integration. See below.
- **Search is optional; two search engines is not.** A content site of a few
  dozen pages is served fine by the browser's own find-in-page, and shipping an
  index it never uses is bundle weight for nothing. So no search library at all
  is `⏭` — there is nothing to check. One is fine whichever it is: Orama is the
  baseline's, and gets `✅`; Pagefind, Fuse, Lunr, Algolia and the rest get a
  `💡` saying so and nothing more.

  What is a defect on anyone's site is *two* engines installed at once — two
  indexes to build, two bundles to ship, and two different answers to the same
  query. That is the only branch that still reports `🔧`.
  → `modules: search:engine` (pairs with `data: search:index`)

  ⚠ **One engine ships as several packages, and counting package names got this
  backwards.** `astro-pagefind` is the Astro integration that wraps `pagefind`,
  and installing both is the documented setup; `algoliasearch` + `@docsearch/js`
  are one product too. A flat list of names called each pair "2 search engines
  installed — two indexes to build" on a site building exactly one. So an engine
  is a *family* of package names in `tools/lib/search-engines.mjs`, and matching
  several of a family is still one engine. Measured on a correct Pagefind site
  and a correct Algolia one, both of which the flat list had two findings about.

  This is what "softening" has to mean if it is to be honest: the requirement
  moved from *presence* to *coherence*. Dropping the dependency without moving
  `data: search:index` to match would have removed the check entirely, so a site
  could ship a search box wired to nothing and hear about it from nobody.
- **A fully static build.** `output` defaults to `'static'` (Astro configuration
  reference, verified 2026-08-02), so *omitting* it is correct and only an
  explicit `output: 'server'` is a departure. The check used to flag any config
  that didn't spell it out — a required finding for writing less config than
  necessary. → `modules: output:static`
- **Rendering on demand means an adapter — any adapter.** A route that renders
  per-request needs one, and without it the build fails outright. The trap is
  that "renders on demand" is *not* the same as `output: 'server'`: a single
  `export const prerender = false` page in an otherwise static site is enough,
  and that is exactly the shape a contact form takes. The check tests for both,
  and names the route it found rather than just the output mode.

  It accepts **any** adapter — Cloudflare, Node, Vercel, Netlify, Deno, or a
  third-party one declared as `adapter:` in `astro.config`. The build fails
  identically on all of them, so naming ours would be house style wearing a
  universal badge. Classified universal for the same reason: a build that cannot
  run is a defect on anyone's site. → `modules: adapter:on-demand`
- **The Cloudflare adapter specifically, only for on-demand `<Image>`.** On a
  fully prerendered build, `astro:assets`' `<Image>` is optimized at *build time*
  by Sharp and emitted to `dist/` — no adapter exists or is needed. The Cloudflare
  image service only matters where pages render on demand *on Workers*, since
  Sharp can't run there.

  This check used to test `output: 'server'` alone, which was a false negative
  with real consequences: a static build with one `prerender = false` page using
  `<Image>` renders on Workers and was never flagged. Widened to the same
  on-demand definition as above. When there is no adapter at all it defers —
  `adapter:on-demand` already reports that, and one defect should produce one
  finding. → `modules: adapter:cloudflare`
- **Set `imageService` explicitly, or you may be buying something.** The
  Cloudflare adapter's `imageService` default changed from `'compile'` to
  `'cloudflare-binding'` (Astro's Cloudflare adapter docs, verified 2026-08-03).
  That service transforms images at runtime through the Cloudflare Images
  binding, which is *"automatically provisioned upon deployment"* — a paid
  product. So installing the adapter for something unrelated (a contact form,
  say) can silently move image transforms from free build-time Sharp onto a
  billed runtime service, with nothing in the build output saying so.

  A `💡` rather than a `🔧`: `'cloudflare-binding'` is a legitimate choice, and
  the only defect is making it by accident. Fires only when the adapter and
  `<Image>` are both present. → `modules: adapter:imageService`
- **Strict TypeScript.** `extends: astro/tsconfigs/strict` catches whole classes
  of content/schema bugs at build. → `modules: tsconfig:strict`
- **`<ClientRouter />` in the root layout.** View transitions / SPA-style nav. →
  `modules: ClientRouter`
- **Webfonts through Astro's own fonts API, not a font CDN.** `fonts:` in
  `astro.config` plus `<Font />` from `astro:assets` self-hosts the files,
  generates fallback metrics so the swap doesn't shift layout, and emits the
  preload link. A `fonts.googleapis.com` stylesheet costs an extra DNS+TLS
  round-trip on the critical path, ships no fallback metrics, and discloses every
  visitor's IP to the font host. Advisory by default — which fonts you use, and
  how, is a defensible choice. → `modules: fonts`
- **Custom `src/pages/404.astro`.** A branded 404, not the host default. →
  `modules: 404:custom`
- **…and the host is actually configured to serve it.** Having the page is not
  the same as shipping it. Cloudflare now documents Workers Static Assets as the
  way to deploy a static site — *"replacing Pages for new projects"* — and there,
  an unmatched URL is answered by the Worker if there is one and otherwise by a
  bare platform 404. The site's own `404.html` is not consulted unless
  `assets.not_found_handling` says so (verified via context7, 2026-09-03):

  > If no matching asset is found and a Worker script is present, the request
  > will be processed by the Worker. If no Worker script is present, a 404 Not
  > Found response is returned.

  > Setting `assets.not_found_handling` to `404-page` overrides the default
  > asset-serving behavior [and] Workers automatically serves the contents of the
  > nearest `404.html` file with a 404 Not Found HTTP status.

  The trap is that this baseline's *own default shape* is the affected one: an
  adapter is required only when a route renders on demand, so a plain content
  site has no adapter, no `main`, and therefore no Worker to fall through to. The
  404 page builds, lands in `dist/`, passes `404:custom` — and never renders for
  a visitor. The starter escapes it only because it has one on-demand route and
  so carries a `main`.

  Read comment-blanked, because `wrangler.jsonc` carries comments by design and a
  commented-out setting satisfying a check is a failure this repo has already
  fixed three times. → `modules: 404:served`
- **Icons are inline SVG — no package, no font.** The glyphs a site uses are
  bodies copied once into `src/lib/icons.ts` from any permissive set (Lucide,
  Tabler, Phosphor are all MIT/ISC and attribution-free), and one component
  inlines them with `currentColor`. Nothing loads that the page does not draw,
  nothing sits on the critical path, and there is no dependency. An icon
  *package* (astro-icon plus an Iconify collection, react-icons, a FontAwesome
  bundle) is a dependency for a dozen paths whose shape invites importing a
  whole set; an icon *font* is worse — a webfont on the critical path, a flash
  of missing glyphs, every icon downloaded whether used or not. The fixture
  went from a package to seventeen inline glyphs in one change (issue #31,
  2026-09-02); the starter ships two. The baseline names no set, because naming
  one is recommending a dependency (§ *Own it before you buy it*). House style,
  both: a site is not broken for choosing a package.
  → `modules: icons` (dependencies), `modules: icons:font` (the built CSS)
- **Media domain in `image.remotePatterns`.** R2-hosted content (`media.<domain>`)
  must be allowlisted or transforms/`<Image>` on it fail. (Only checkable when
  `scripts/og.config.mjs` declares the media domain.) → `modules: remotePatterns`

### Astro 7 migration residue

Config and imports that were valid on Astro 6 and are *wrong* on 7 — the kind of
thing a version bump leaves behind. Each maps to a documented v7 breaking change.

- **No stabilized flags left under `experimental:`.** v7 promoted `logger`,
  `cache`, `routeRules`, `queuedRendering`, `rustCompiler` and `advancedRouting`
  out of experimental. Left in the `experimental` block they are unknown config
  keys, not harmless no-ops — `logger`/`cache`/`routeRules` move to the top
  level, the other three are simply the default now. →
  `modules: astro7:experimental`
- **Unified()-only markdown options are backed by `@astrojs/markdown-remark`.**
  v7 renders Markdown with Sätteri and no longer installs that package. The
  deprecated `markdown.remarkPlugins` / `rehypePlugins` / `remarkRehype` options
  still work, but *only* with it installed and `markdown.processor: unified()`
  set; otherwise the plugins silently never run. Sites with no remark/rehype
  plugins need nothing — Sätteri applies GFM and SmartyPants like before. →
  `modules: astro7:markdown`
- **No `@astrojs/db`.** The package was removed in v7 and is unmaintained. Use
  `node:sqlite`, Drizzle, or a hosted DB. → `modules: astro7:db`
- **No removed `astro:transitions` internals.** `TRANSITION_*` constants,
  `isTransitionBeforePreparationEvent()`, `isTransitionBeforeSwapEvent()` and
  `createAnimationScope()` are gone; use the lifecycle event names directly
  (`'astro:before-preparation'`, `'astro:after-swap'`, …). An import of a removed
  export is a build failure, so this catches it before deploy. →
  `modules: astro7:transitions`
- **`compressHTML` is set explicitly.** v7 changed the default from `true` to
  `'jsx'`, which strips whitespace by JSX rules — including the newline between
  prose and an inline element. Measured on astro@7.1.6:

  ```astro
  Tasman Visa operates the website
  <a href="…">tasmanvisa.com</a>. Your privacy is important to us.
  ```

  builds as `operates the websitetasmanvisa.com.` with the default, and keeps the
  space with `compressHTML: true`. It builds clean, typechecks clean, and is
  wrong only in the rendered text — tasmanvisa-web had it live on their privacy
  page. → `modules: compressHTML`

  The check accepts **either value**. What it refuses is the field being unset,
  because inheriting a changed default is not choosing one. The baseline itself
  takes `true`: a content site is exactly where prose meets inline elements
  constantly.
- **`tsconfig.json`'s own `exclude` still covers `dist`.** Astro's shipped
  tsconfigs exclude it, but a project that declares its own `exclude` *replaces*
  that list rather than adding to it, and `astro check` then type-checks the
  built bundle. cypruspokerbrisbane got ~70 spurious warnings out of a built
  `chart.js` this way, and 0/0/0 once `dist` went back in. No `exclude` at all is
  correct and passes. → `modules: tsconfig:exclude-dist`
- **The upgrade is verified mechanically, not by reading.** The guide is 333
  pages and the two changes above are both silent, so `astro:version`'s fix hint
  now carries the procedure that actually caught them: build on the old version,
  snapshot `dist/`, upgrade, rebuild, and diff the rendered visible text **with
  tags stripped to empty** — not to a space, which masks precisely the
  `compressHTML` change. That took tasmanvisa-web from "hope it is fine" to "332
  of 333 pages byte-identical, and the one difference is a fix".

## seo — the discoverability surface

*Check file: `tools/checks/seo.mjs`. Source: `src/components/SEO.astro`,
`scripts/og.config.mjs`, `astro.config.*`. (Structured data lives under `data`.)*

- **One SEO component emits canonical + OG.** Every page gets a
  consistent head surface from a single component, not ad-hoc per-page tags:
  `canonical`, `og:image`, `og:image:width`/`height`, `og:type`, `og:url`.
  (Twitter/X falls back to the OG tags, so a dedicated `twitter:card` isn't
  required.) → `seo: meta:<tag>` (offline, scans the component source) +
  `seo: og:<tag>` (live, the rendered `<head>`)
- **The og:image is a real card, not just a 200.** A resolvable image URL
  (status + `image/*` content-type) is necessary but not sufficient: a generator
  that screenshots an *error* page uploads a perfectly valid PNG. That's the
  an incident on a real site incident — a site on `trailingSlash:'always'` had its generator
  request the no-trailing-slash `/preview/og/<slug>` → 404 → it screenshotted
  and shipped Astro's 404 page as the post's OG card, and status+content-type
  alone never caught it. The live check fetches the served bytes and verifies the
  intrinsic dimensions: at least the OG minimum (600×315, below which platforms
  crop or reject), and matching the declared `og:image:width`/`height`. →
  `seo: og:image:card` (live; 💡 `og:image:dimensions` when served ≠ declared).
  *Boundary:* the same-viewport case (a 404 shot at the real 1200×630 viewport)
  is indistinguishable from headers/bytes — the fix for that is a `resp.ok()`
  guard in the **generator** (assert a 200 before screenshotting), which lives in
  the audited site, not here. rider documents the practice; the site
  implements the guard.
- **The head meta is on every published page, not merely somewhere.** Coverage
  is measured over the pages the **sitemap** declares — the site's own answer to
  "what am I publishing". Every other denominator is wrong: "every file in
  `dist/`" counts OG-image templates and preview routes that correctly carry no
  canonical, and "pages that have a canonical" (which is what `isContentPage`
  means) makes the canonical check measure itself — delete the canonical from 18
  of 19 pages and the set shrinks to 1, which reports 1/1 ✅. A dogfood agent
  reproduced exactly that. All → pass, none → fix, some → 💡 naming the pages.
  → `seo: meta:*`
- **The three tags a search result is made of are checked offline too.**
  `<title>`, `<meta name="description">` and `og:title` were **live-only** until
  2026-09-04, which meant the *default* audit — the one you run without a URL —
  never read them at all. A site could ship an empty `<title>` on every page,
  pass `seo` clean, and hear about it only from whoever remembered `--url`.
  They are judged over the same sitemap denominator as the rest of the head
  surface, and the built-HTML matcher requires a non-empty `content`: a tag that
  rendered as `content=""` has the markup and none of the value. That distinction
  was itself a bug for one commit — `content\s*=\s*["'][^"']*\S` matches `content=""`,
  because `\S` is happy to be the closing quote. The value has to be bounded on
  both sides. → `seo: meta:title`, `meta:description`, `meta:og:title`
- **`og:image:width`/`height` are advice, not a requirement.** A card renders
  without them; they only let a platform reserve space before fetching it. Two
  independently-built, well-made dogfood sites had these two as their *only*
  required finding — which is the signal that the severity was wrong rather than
  the sites. → `seo: meta:og:image:width`, `seo: meta:og:image:height` (💡)
- **Each page's canonical is its own URL.** Presence is not enough: a site where
  twenty pages all declared the same canonical passed, and that markup asks
  crawlers to drop nineteen of them as duplicates — strictly worse than having no
  canonical at all. Only a value covering *more than half* the pages is reported,
  and only as advice, because deliberate duplicates are legitimate: the bundled
  i18n fixture shares a canonical between a locale fallback rewrite and the page
  it mirrors, which is correct. → `seo: canonical:unique`
- **No `<meta name="keywords">`.** Ignored by search engines and a weak spam
  signal — its presence is the anti-pattern. → `seo: no-keywords`
- **Brand fields set:** `siteName`, `siteUrl`, `tagline` feed the SEO meta. →
  `seo: brand.<field>` (and 💡 `brand:optional` for author/twitter handles)
- **`robots.txt` served, pointing at the sitemap — with an absolute URL.** The
  built site must carry a `robots.txt` with a `Sitemap:` line: that line is how a
  crawler starting at the root finds the full URL list. Read from
  `dist/robots.txt`, so any way of producing it counts — an endpoint, a
  `public/` file, or an integration. The value is read **as a URL**, not as a
  non-empty string: the spec requires an absolute one, and a relative
  `Sitemap: /sitemap-index.xml` is the mistake that looks most correct. And
  because `dist/` *is* the served surface on a static build, a line pointing at a
  file this build never wrote earns a 💡 naming what it did write —
  `@astrojs/sitemap` emits an index plus numbered parts, not `/sitemap.xml`,
  which is Search Console's "sitemap could not be read" before anyone deploys.
  The suggestion names the two platform primitives and no third-party
  integration; this tool does not send anyone shopping (*Own it before you buy
  it*, above). → `seo: robots` (`⏭` with no `dist/`)
- **Sitemap carries lastmod.** Read from the built `sitemap*.xml`: how many
  `<url>` entries carry a `<lastmod>`. `@astrojs/sitemap` emits none unless a
  `serialize()` supplies one (verified against the integration docs), so the
  integration being configured proves nothing — the old check inferred it from
  `astro.config` and passed two dogfood sites whose sitemaps had zero `lastmod`.
  Advisory: a crawler tolerates its absence, it just can't tell what changed.
  → `seo: sitemap:lastmod` (`⏭` with no `dist/`)

- **The sitemap is judged against what Google actually does with it.** Verified
  against Google's *Build and submit a sitemap* on 2026-09-04 rather than from
  memory, because half of what a sitemap can carry is read by nobody:
  - **`<changefreq>` and `<priority>` are documented as ignored.** They are in
    the sitemap spec, they are what people hand-tune (a `priority` of 1.0 on the
    homepage *feels* like it must do something), and Google's own documentation
    lists both as unused. Shipping them is not a defect, just maintenance that
    buys nothing — so this reports the fact and never fails, in either mode.
    → 💡 `seo: sitemap:hints` (advisory in `policy.mjs`)
  - **Absolute URLs, and inside the caps.** 50,000 URLs and 50 MB uncompressed
    are per-file hard limits, and going over either loses the *whole file*
    rather than the overflow. `@astrojs/sitemap` splits at `entryLimit` on its
    own, so this fires on hand-rolled endpoints — which is exactly where a
    relative `<loc>` shows up, the mistake that looks most correct because every
    other line a site writes about itself is a path. A sitemap spanning several
    origins is advice, not a finding: legal once each is verified in Search
    Console, and far more often a stale `site`. → `seo: sitemap:urls`
  - **`<lastmod>` is counted only where it parses.** Google reads it "if it's
    consistently and verifiably accurate", and the value must be a W3C datetime
    — `March 3, 2026` is a string that gets the element ignored. A malformed one
    is therefore counted as the absence it effectively is, rather than as its own
    required finding: making it 🔧 while a *missing* lastmod stays 💡 would tell a
    site it is better off deleting the element than fixing it.
    → 💡 `seo: sitemap:lastmod`

- **Three ways a sitemap can contradict the site it describes.** A sitemap is a
  request to index every URL in it, so the failures worth catching are the ones
  where the site says the opposite somewhere else. None is visible from either
  half alone, and all three are named errors in Search Console:
  - **`noindex` on a submitted URL.** The page asks to be dropped while the
    sitemap asks for it to be added. Usually a staging value that survived, and
    the highest-consequence SEO defect there is — which is why nothing checked
    it here until 2026-09-04 was the gap worth closing first. The discriminator
    is the sitemap: the bundled i18n fixture `noindex`es its preview routes
    *correctly*, and they are filtered out of the sitemap, so they are not
    findings. → `seo: sitemap:noindex`
  - **Blocked by `robots.txt`.** The crawler is told to fetch it and told not
    to. Resolved the way the standard does — longest matching rule wins, `Allow`
    wins a tie — which is why `Allow` is parsed at all: reading `Disallow` alone
    reports `Disallow: /blog` + `Allow: /blog/public/` as blocking
    `/blog/public/`, a finding against a correct file. → `seo: sitemap:blocked`
  - **A canonical pointing elsewhere.** The URL is submitted and then disclaimed
    by the page that answers it — Google's "Duplicate, submitted URL not selected
    as canonical". *Unless the sitemap itself declared the consolidation:* a
    locale fallback rewrite serves the default locale's page and correctly
    canonicalises to it, and the entry's own `<xhtml:link>` alternates say so.
    Without that exemption the bundled i18n fixture, which is correct, collected
    two required findings — the check was written against it before it was
    written against anything else. A trailing-slash-only difference is 💡: still
    two URLs to a crawler, rarely the thing worth failing a build over.
    → `seo: sitemap:canonical`

  Backtested before shipping, counting the wrongs rather than the rights:
  **6 real public sites plus both bundled examples, 8 corpora, 0 false
  positives.** The one required finding it produced is real — a large,
  well-built site whose sitemap submits `/blog/release-notes/<version>` for
  pages that each canonicalise to a different `/blog/<slug>`, on all 8 sampled
  pages. `sitemap:hints` fired once, on a sitemap carrying `<changefreq>` and
  nothing else, 18,134 times.

- **hreflang alternates on a multi-locale site.** Two or more locales in the
  config and no `hreflang` anywhere means each translation competes with the
  others as a duplicate. Either carrier counts: `@astrojs/sitemap`'s `i18n`
  option writes `<xhtml:link rel="alternate">` into the sitemap (verified via
  context7 against the integration docs, 2026-09-04), and a per-page
  `<link rel="alternate" hreflang>` in the head says the same thing. It runs
  **only** when the config names ≥2 locales — on a single-language site there is
  nothing to alternate between, and firing there would be the one thing a check
  must never do. This was a tracked gap for a month: the fixture smoke test
  covered it, the audit did not. → `seo: hreflang`

- **Exactly one `<h1>` per content page.** The `<h1>` is the page title; zero
  means no main heading, more than one dilutes the document outline for search
  engines and screen readers. Checked on built `dist/` HTML (pages with a
  canonical link — so OG-template / preview routes are excluded) and live on
  home + a content page. → `seo: headings:h1` (required)
- **Don't skip heading levels.** A sequential outline (h2→h3→h4, never h2→h4)
  is a WCAG 1.3.1 expectation. Advisory, not required — a skip is most often a
  shared header/footer using a deeper level, not a content bug, so it shouldn't
  fail an otherwise-clean run. → 💡 `seo: headings:order`

  **The finding names the component, not the built page.** Reporting
  `dist/wiki/index.html` for a level written in a shared layout leaves the reader
  the actual work — the built page is where it showed up, the component is what
  they have to edit. The offending heading's *text* is matched back against
  `src/`, and a location is claimed only when **exactly one** source file
  matches: a heading rendered from frontmatter (`<h2>{title}</h2>`) has no
  literal to find, and two components sharing a heading text are ambiguous. Both
  fall back to the built path, because a confidently wrong pointer is worse than
  the artifact.

### The blind spots, closed 2026-09-04

Seven things three competing Astro auditors check and this one did not. The list came from
reading their rule ids rather than their marketing —
[`astro-seo-audit`](https://github.com/namanlabc/astro-seo-audit)'s `src/rules/` and
[`astro-post-audit`](https://github.com/casoon/astro-post-audit)'s documented categories.
Each is paired below with the case that must **not** fire, because five of the seven
would have flagged our own compliant examples written the obvious way.

Two of them found real bugs in `examples/_fixture-i18n` — the site this repo holds up as
the existence proof of the baseline — before a line of the checks had shipped. That is the
argument for all seven.

- **`<html lang>` — the one head attribute nothing here had ever read.** A screen reader
  takes its pronunciation from it, and without one it guesses. WCAG 3.1.1 is a
  conformance failure rather than a preference, which is why it is required on anyone's
  site. **It is not a ranking signal for Google**, which says so outright: "Google doesn't
  use hreflang or the HTML lang attribute to detect the language of a page; instead, we use
  algorithms." So this rule answers to WCAG, not to Search Central. It is also what `hreflang` quietly assumes:
  alternates that all declare the same language say nothing. Loose BCP 47 — this is here to
  catch `lang=""` and `lang="english"`, not to referee the registry. → `seo: html:lang`
- **One canonical, absolute, and one `<title>`.** Two canonicals is the failure that reads
  as diligence: Google discards the pair, so a page that declared its URL twice declared it
  zero times. A relative canonical is the same class — legal HTML that resolves against
  whatever URL served the page, which is exactly the parameterised duplicate a canonical
  exists to collapse. *The guard:* `<title>` is also an **SVG** element. An inline diagram
  with labelled nodes puts three in the body, and counting those reported "more than one
  `<title>`" on four pages of a real documentation site that has exactly one each — so the
  scan is head-scoped. → `seo: canonical:value`
- **Internal links that go nowhere.** A 404 behind an `<a>` is invisible to every other
  check here: the markup is perfect, the target simply is not there. It found one on the
  first run — the bundled fixture's own blog emitted `href="/2"` for page two, because
  Astro documents `page.url.first` as *undefined when you are on the first page* and the
  component's `?? ''` fallback turned that into a root-relative link. Page two of our
  reference blog 404'd. *Two guards:* any built file is a valid target, not just HTML
  (`/rss.xml`, `/llms.txt`, `/og/default.png` — treating those as broken reported the
  starter's own footer); and **a relative href resolves against the page's URL, not its
  file path**. A page built to `blog/a/index.html` is served at `/blog/a`, so `./b` means
  the sibling, not a child of itself — the file-path version reported 99 working links as
  broken on a real 57-page site. Both bundled examples link with absolute paths and never
  exercised the difference, which is precisely why a real corpus is not optional.
  → `seo: links:internal`
- **Pages nothing links to.** Three of the fixture's own pages — `/about`, `/design`,
  `/media-kit` — shipped, sat in the sitemap, carried perfect head meta, and were linked
  from nowhere on the site. `browser: nav:reach` checks that every route *the nav offers*
  survives to phone width; it had never asked whether a published page is offered at all.
  **Advisory, permanently:** the starter's `contact/thanks` is reached by a form redirect
  and is correctly an orphan, and nothing in a build distinguishes that from a page someone
  forgot. → 💡 `seo: links:orphan`
- **A title or description used twice.** It tells a crawler two URLs are the same page,
  which is what a canonical exists to say deliberately. *The guard* is the locale pair, and
  it is the same discriminator `sitemap:canonical` uses: a page is exempt when the sitemap
  itself declares the other as its `hreflang` alternate. Unlike `canonical:unique` there is
  no majority threshold, because the two are not the same shape — a canonical shared
  site-wide de-indexes a site, whereas two pages sharing a title is already a problem for
  those two. Advisory in every mode, which is what makes the lower bar affordable.
  → 💡 `seo: meta:unique:title`, `meta:unique:description`
- **What the sitemap left out.** Every other coverage check judges the pages the sitemap
  lists; this is the only one that asks what is missing from it. *Four exemptions, each
  measured:* an error page (both examples ship a `404.html` carrying a canonical and no
  noindex, so it looks publishable to every other test here), a page with no canonical (an
  OG template or preview route), a `noindex` page — `sitemap:noindex` owns that case — and
  one robots.txt already disallows. House style: which pages a site submits is its own
  call, unlike the three `sitemap:*` contradictions, which are the site disagreeing with
  itself. → 💡 `seo: sitemap:coverage` (🔧 under `--strict`)
- **`Disallow: /` for everyone.** Nearly always a staging `robots.txt` that shipped, and it
  is total — no sitemap, canonical or JSON-LD underneath it can matter. Resolved with the
  same longest-match logic as `sitemap:blocked`, so a site-wide `Disallow` that a longer
  `Allow` reopens is correctly not a finding. → `seo: robots:blocks-all`
- **Robots-meta directives Google implements, on URLs it can reach.** Two silent
  failures, and both look like diligence from the inside. A misspelled directive
  (`noidex`) is simply ignored, so a page a site believes it withheld is indexed.
  And a `noindex` on a URL `robots.txt` disallows can never be read at all —
  Googlebot is forbidden to fetch the page, so it never sees the tag, and the URL
  can still be indexed from links pointing at it. Google states the second
  outright: if a page is disallowed, "any information about indexing or serving
  rules will not be found and will therefore be ignored". Directives are matched
  against the full documented list, page-level and text-level, so a real one is
  never called a typo. → `seo: robots:meta`
- **A favicon Google can actually read.** Its list is BMP, GIF, ICO, PNG, JPEG,
  PPM and TIFF, and **SVG is not on it** — which matters because an SVG-only
  favicon is now a common, modern-looking choice that costs a site its icon in
  every result. Measured on a 27-site sweep: three ship an SVG as their only icon
  and serve nothing at `/favicon.ico` (one of them 301s `/favicon.ico` to the SVG,
  which fails the same way), so their results carry the generic globe. Our own
  starter did the same until this check was written. Both carriers count: the
  documented `<link>` on the home page, and `/favicon.ico` at the root — three
  sites in the same sweep ship no `<link>` at all and are served an icon from the
  root file, so flagging them would have been wrong about three real sites. The
  icon must also be square, and Google recommends above 48px.
  → `seo: favicon`, `seo: favicon:size`
- **A viewport meta on every page.** Without it a phone lays the page out at
  desktop width and scales the result down: every tap target too small, every
  line too long. It is one line in the root layout, so a page missing it is
  almost always a page that never went through the layout — which is the more
  useful thing the finding tells you. → `seo: viewport`
- **hreflang alternates a crawler can follow.** Declaring alternates is one
  practice; declaring usable ones is another, and Google ignores a cluster that
  fails any of four rules. Alternate URLs must be fully-qualified — a real site in
  the sweep declares `../fr/` on 23 pages. The language tag must be one Google
  parses: ISO 639-1, optionally a script, optionally an ISO 3166-1 alpha-2 region,
  and nothing wider. That is narrower than BCP 47 on purpose — Google names
  `es-419` as unsupported, so a UN M.49 region or a three-letter language is a
  finding here although a validator would accept it. Case is not: Google reads
  the value case-insensitively. `en-UK` is the classic error, since the country is GB, and
  another site ships `en-AE-x-dubai`, a private-use tag Google does not read.
  Each version must list itself. And the links must be reciprocal: "if page X
  links to page Y, page Y must link back to page X." Reciprocity is checked only
  between pages this build produced — an alternate on another host is not ours to
  verify. It found a real bug in our own i18n fixture on the first run: Hungarian
  pages prefixed their own locale twice and pointed at `/hu/hu`, a URL the site
  does not build. → `seo: hreflang:valid`
- **Link text that says where it goes.** "Avoid writing generic anchor text like
  page, article, or click here." Advisory, and staying that way: a blog card whose
  whole surface is the link legitimately reads "Read more", and 29 of the 66 hits
  in the 27-site sweep were exactly that pattern. What makes it worth reporting is
  the other reader — someone tabbing through a page's links hears them as a list,
  where nine identical "Read more" say nothing. The check reads the accessible
  name, so an `aria-label` or an image `alt` counts as the text.
  → 💡 `seo: links:anchor-text`

**Backtested before shipping, counting the wrongs.** Eight corpora — six real public sites
plus both bundled examples — and, because the link-graph checks are meaningless against a
partial mirror, one **complete** 57-page mirror of a real site for those three. Final count:
**0 false positives.** Getting there cost two bugs of our own, both found by that complete
mirror and both now regression-tested: the relative-href resolution above, and `existsSync`
answering *true for a directory*, which made every link to a section resolve to a path no
page could match and reported 42 of the fixture's 43 pages as orphans on a site whose nav
works.

## images — content images delivered well

*Check files: `tools/checks/images.mjs` (offline: source + built `dist/`) and
`tools/checks/live.mjs` (served HTML). Shared param logic: `tools/lib/cf-image.mjs`.*

- **Built images are named after what they show.** "Use short, descriptive
  filenames" — Google names `IMG00023.JPG` and `image1.jpg` as what to avoid,
  because the filename is one of the few things Google Images has to go on.
  Advisory by construction: a camera default is a housekeeping smell rather than a
  defect, and renaming a shipped file breaks every URL already pointing at it,
  which is a real cost the tool is not entitled to demand. The pattern is real —
  a scan of `<img src>` across 27 public sites found ten such names on four of
  them (`photo1.webp`, `image4.png`, `Untitled-1`) — but note the scope: this
  check reads the FILES a build ships, the same denominator as `dist:size`, so a
  site serving its images from elsewhere is not judged here. Astro's own output
  is exempt by construction — `hero.CdEf1234.png` is a content hash on a
  descriptive name.
  → 💡 `images: filename`
- **A file read only through `/cdn-cgi/image/` is the edge's input, not a
  payload.** Its bytes on disk are what Cloudflare resizes; what a visitor
  downloads is decided at the edge and is measurable only live. Judging the input
  reported a 2.3 MB required finding against a site shipping exactly the transform
  ladder `images: routed` recommends. A file the HTML also links directly really
  does ship, and keeps the plain rule. → `images: dist:size` (see judgeDistSizes)

- **Where media lives (2026-09-02).** Two lanes, and which one is not a
  preference. *Site chrome* — logo, favicon, one hero, the OG cards — is a
  handful of files that never change, lives in the repo under `src/assets/`,
  and goes through Astro's `<Image>` at build, which is what lets the starter
  build with no Cloudflare account. *Content media* — photos in posts, anything
  editorial, anything that grows — never enters git. It goes to one R2 bucket
  per site behind `media.<domain>`, and every page requests it through
  Cloudflare's transform URL (`/cdn-cgi/image/width=…,quality=80,format=auto/…`)
  so the edge produces each size on demand and nothing is resized at build.
  Git stores every version of every binary forever, so a photo edited twice
  costs three copies in every clone, and it drags optimisation back into the
  build. **The bucket is the media repo**; `wrangler r2 object list` is the
  inventory and there is no manifest to drift. A post references a *key*
  (`blog/<id>/cover.jpg`), never a URL, so the domain has one home. Keys follow
  the content so a post and its media share a name. The one thing the build
  cannot do for a file it never sees is read its dimensions, so the upload path
  records them into the frontmatter — reading a number, not resizing — and the
  tag carries width/height like any other. In the starter: `Cover.astro` renders
  either lane, `src/lib/media.ts` builds the URLs, `npm run media` uploads and
  prints the frontmatter, `astro.config` derives `remotePatterns` from the same
  brand file. No new check: the delivery half is already every rule below plus
  `modules: remotePatterns`, `perf: preconnect`, and the live image loop that
  fetches every served content image with a browser Accept header. Exercised
  by setting a media domain and a key on a starter post: the audit found the
  missing preconnect and the missing remote pattern in the first run, and a
  wrong `crossorigin` rule in the second — all three fixed in the same change.
- **Content images go through an image transform.** Either Astro build-time
  optimization for local assets (`/_astro/…`) or Cloudflare Image
  Transformations for R2 content (`/cdn-cgi/image/…`) — never a raw full-size
  `<img>` to the media domain. → `images: routed`, `images: background-image`
- **No oversized rasters at the source or in the build.** A >500 KB PNG/JPG in
  `src/assets/`, or a >300 KB content image in `dist/`, means something never got
  resized. → `images: assets:size`, `images: dist:size`

  **A responsive image is judged as a ladder, not as files.** The browser
  downloads exactly one rung of a `srcset`, so the budget applies to the
  *smallest* rung — what a phone actually gets — not to the largest. Flagging the
  top rung was a false positive with no legal fix: Astro emits the intrinsic
  width unconditionally (`image.breakpoints` only adds widths *below* it), so the
  only way to satisfy it was to downscale the source and degrade retina desktop
  to improve a number no user experiences. A ladder is a defect when even its
  smallest rung is over budget; a single image referenced by no `srcset` is still
  judged on its own bytes. Ladders are read out of the built HTML — an `<img>`'s
  `srcset` plus its `src` fallback, and each `<source>` in a `<picture>`.
  Reported by `tasmanvisa-web`, 2026-08-02.
- **A CSS background does not pin a width.** `background-image` gets neither
  `srcset` nor lazy loading, and neither is recoverable: whatever width is
  hardcoded is what every device downloads, and the fetch starts as soon as the
  rule matches an element — so cards four screens down compete with the LCP image
  for bandwidth. tasmanvisa-web had `QuoteCTA` pinned at `width=1600`, so phones
  fetched a 1600 px photo for a 393 px viewport; the home page shipped ~1.1 MB of
  CSS backgrounds and audited `images ✅ all`. Converting 19 of them took that
  page from 1834 KB to 925 KB. → `images: background-image:fixed-width`

  The fix is an absolutely-inset `<img>` with `srcset`/`sizes`/`loading="lazy"`
  inside a positioned parent. `image-set()` is exempt — it does DPR selection,
  which is less than an `<img>` gets but more than nothing. Scanned in source
  rather than `dist/`, because the fix is a template edit and that is where the
  finding should point. Widths under 640 px are not flagged: a pinned width that
  small is roughly what a phone wants anyway, and flagging a decorative texture
  is the noise that gets a tool ignored.
- **A large image ships a ladder, not one fixed width.** Everything above judges
  responsive images that already exist — the smallest rung of a `srcset`, a CSS
  background that can never have one, an overstated `sizes` measured in a
  browser. None of them says the thing that is arguably worth more: *this image
  is large and ships as a single width, so every phone downloads the desktop
  file*. That is this check. → `images: srcset:missing` (house style: 💡 by
  default, 🔧 under `--strict`)

  A candidate is a built `<img>` with no `srcset` and no `<picture>` ancestor
  (its `<source>` siblings are the ladder) whose delivered width is knowable —
  the width a `/cdn-cgi/image/` URL pins, or the intrinsic width of the file it
  resolves to in `dist/`. PNG, JPEG, WebP and AVIF are all readable from their
  own bytes (`tools/lib/image-size.mjs`); a remote host is unknowable offline,
  and an unknown width is never a finding.

  **Delivered width, not the number in the URL — `dpr` multiplies it.**
  Cloudflare's transform vocabulary has `dpr` (default 1, max 2), so
  `width=600,dpr=2` delivers 1200 px while the URL says 600. Reading the stated
  number alone put that under the 1000 px floor and the check went quiet on
  exactly the image it exists for — a false *negative*, which is the tolerable
  direction and still wrong. Measured rather than reasoned: a live resizer
  carrying the same parameter returned 1200×720 for `?width=600&dpr=2` and
  600×360 for `dpr=1` (2026-09-04, issue #35).

  **Unknowable is reported, never silent — including a URL with no extension.**
  An image CDN that serves by opaque id (`…/ads/9f3c-4a1e?rule=…`) has no file
  extension, and the content-image gate dropped those before they reached the
  unmeasurable tally, so a page carrying 53 of them reported `⏭ nothing to
  check`. That is the same failure the tally was added for in #21, one gate
  earlier. A remote `<img src>` with no extension is now counted and named —
  counted, never judged.

  AVIF was the exception until issue #21, and it was the expensive kind of
  silence: a build that emits avif produced `⏭ nothing to check` — the same line
  a site with no images gets — because every candidate's width was unreadable.
  Reading it means walking ISOBMFF boxes to the `ispe` the primary item claims,
  not the first one in the file, since a thumbnail or an alpha plane carries its
  own and taking the wrong one understates the width the browser paints.

  **The trap, and why this took three attempts to ship.** A legitimately
  fixed-width image is common and *correct*: a logo, an avatar, an icon, a
  diagram rendered at exactly one size. Flagging those is the crying-wolf
  failure `tools/lib/policy.mjs` exists to prevent, and it is worse than not
  having the check. So the thresholds are measured rather than chosen. Across
  three real builds (tasmanvisa-web, matevisky-web, mergodon-com-web), every
  single-width image that was *meant* to be one came in at ≤ 720 px — badge
  strips at 200–300, portraits at 240–640, footer logos at 220 — while every one
  that should have had a ladder was a 1200–1600 px photograph. Hence **1000 px**,
  which sits in the empty gap between the two populations rather than at a round
  number someone liked. Two further guards cover the wide-but-legitimate case: a
  **50 KB** floor when the bytes are knowable (the same build's 1594 px brand
  lockups are 21 and 25 KB, while its wide photographs start at 46 KB), and a
  name filter for `logo`/`lockup`/`badge`/`icon`/`avatar`-shaped paths. Each of
  the two real false positives the sweep produced is excluded by *both*.

  Exempted images are counted, not discarded, so the pass line can say "none
  needed a ladder (2 of them wider than 1000px, but …)" instead of implying
  nothing wide was there — which would be a false statement about precisely the
  images the guards exist for.

  **Promoted out of advisory on 2026-09-03**, on the sweep issue #12 set as the
  condition and issue #21 tracked: *a wider real-site sweep showing it stays
  quiet on correct code*. It ships as house style — 💡 by default, 🔧 under
  `--strict` — rather than universal, because it remains a threshold on a
  judgement call and a stranger's site should never fail a build over one.

  The sweep, re-run over the population rather than spot-checked:

  | | sites | measurable candidates | findings | wrong |
  |---|---|---|---|---|
  | ours (2026-08, #12) | 3 | 23 | 7 | 0 |
  | public Astro sites (2026-09-03) | 7 | 43 | 18 | 0 |

  The public half is what earned the promotion: seven repos written by people
  with no connection to this project, cloned and built from source — among them
  `satnaing/astro-paper` (5k★), `themefisher/bookworm-light-astro` and
  `davidvkimball/astro-modular`. The findings were 4000 px / 1.9 MB author
  photographs, 2400–3840 px in-content screenshots, and 1080 px post
  photographs — all true, none arguable.

  What earned it was the **silence**, not the hit rate. Twenty-five wide
  candidates were correctly left alone, and the byte floor fired on exactly the
  shapes it was designed for: a 1200 px / 27 KB quote graphic, a 1190 px / 24 KB
  logo, a 1096 px / 5 KB placeholder. Those are the "legitimately fixed-width
  illustration" case the guards exist for, found in the wild rather than
  constructed. The name filter never had to fire — the byte floor caught every
  one first, which is worth knowing if either threshold is ever revisited.

  Thirty further candidates were unmeasurable, nearly all remote URLs (Unsplash,
  Cloudinary, GitHub asset links) on one site. They are counted and named rather
  than dropped, per #21's second half.
- **The transform actually runs — Image Transformations is a per-zone toggle.**
  Everything else here judges the *shape* of a `/cdn-cgi/image/` URL: the params
  it carries, the width it pins, the bytes it returns. None of it asks the only
  question that matters first — did Cloudflare transform anything? Transformations
  have to be switched on per zone (dashboard → Images → Transformations → select
  the zone), so a site can emit textbook transform URLs on every image and serve
  none of them. Measured 2026-09-03 against a real site:

  ```
  /cdn-cgi/image/width=800,format=auto,quality=80/…/hero-coastal.webp
    200  image/webp  71,366 bytes
    cf-resized: internal=ok/m q=0 n=372+145 c=22+37 v=2026.9.0 l=71366 …
  …/hero-coastal.webp            (the same file, prefix removed)
    200  image/webp  258,874 bytes   ← no cf-resized header
  ```

  `cf-resized` is the signal, and its absence on a 200 means the original bytes
  were served — 3.6× the payload, indistinguishable in the HTML. On failure the
  header carries `err=<code>` instead, and the codes are documented and
  actionable: `9422` is the 5,000-transformation free-tier limit, `9412` an
  origin serving an HTML error page, `9524` a Worker intercepting the image *or a
  `pages.dev` URL* (custom domain required). The map is in
  `tools/lib/cf-image.mjs`, with the docs link.
  → `images: transform:applied` (live)

  **Universal, not house style**, and the distinction is the point: this never
  asks a site to adopt Cloudflare transforms — it fires only once the site has
  chosen them and they are demonstrably not running. Same coherence shape as
  `data: search:index`, which fires only when a search library is installed.
- **A content image the page requests actually resolves.** With the zone toggle
  off, every transform URL 404s — and the live loop read a `content-length` of 0
  off it, compared 0 against the 300 KB budget, and reported nothing. `routed`
  passed too, because the URL *shape* was right. A wholly dead image lane audited
  as `✅ routed, 0 findings`. Status is checked before anything is measured now,
  and when every dead image is a `/cdn-cgi/image/` URL the finding names the
  toggle rather than listing N broken files: that is one switch, not N bugs.
  → `images: resolves` (live)
- **Transforms use `format=auto`, not an explicit format.** `format=auto` lets
  Cloudflare negotiate AVIF/webp per the browser's `Accept`; an explicit
  `format=webp` (the default Astro emits for bare markdown `![]()`) means no AVIF
  *and* a raw-source fallback for clients that don't accept that format (via
  `onerror=redirect`). → `images: transform:format` (offline + live)
- **Transforms set an explicit `quality=`.** Cloudflare defaults to 85; an
  explicit cap (e.g. `quality=80`) is usually a large win on photographic
  content. → 💡 `images: transform:quality` (house style — `💡` by default,
  `🔧` under `--strict`; `tools/lib/policy.mjs` carries the reason it is not
  required of everyone).
- **Measure served bytes the way a browser sees them.** The live byte check
  sends a real `Accept: image/avif,image/webp,…` so a `format=auto` transform
  negotiates the format an actual visitor downloads — not the raw source a
  headerless probe would trigger. → `images: bytes` (live)
- **Content images carry alt text.** Every content `<img>` needs an `alt`
  attribute (WCAG 1.1.1). `alt=""` is allowed — it signals a decorative image —
  but a *missing* attribute is the violation. `<Image>` from astro:assets
  enforces this at build; raw `<img>` and bare markdown can slip through.
  Checked on built `dist/` HTML and live. → `images: alt` (required)

  Every `<img>` tag counts, on every page. The check used to de-duplicate by
  `src` across the whole build, so the *first* occurrence of an image decided the
  verdict for all of them: the same photo used with alt on the homepage and
  without alt on a post was reported as fine. Four of five independent dogfood
  builds found that — a silent false negative with exit 0, which is the worst
  outcome this tool has. Each offending page is now its own finding, named.

## perf — page-speed levers

*Check file: `tools/checks/perf.mjs` (offline) and cache checks in
`tools/checks/live.mjs` (served).*
- **Hashed assets are immutable.** `public/_headers` marks `/_astro/*`
  `public, max-age=31536000, immutable` so repeat visits don't re-validate every
  JS/CSS/font. (A plain `astro dev` server doesn't apply `_headers` — the live
  check needs `wrangler dev` of `dist/` or the deployed site.) →
  `perf: _headers:/_astro/*`, live `perf: cache:_astro`
- **HTML revalidates.** HTML routes must *not* be immutable, or deploys won't
  show until the cache expires. → live `perf: cache:html`
- **Content `<img>` carry width + height.** Explicit dimensions (or `<Image>`,
  which bakes them) prevent layout shift (CLS). → `perf: cls:img-dimensions`,
  live `images: cls`

  **…unless CSS takes the image out of flow, in which case demanding them is
  cargo cult.** An absolutely-positioned image has no siblings to push, and
  `inset: 0` + `height: 100%` override the intrinsic-ratio box the attributes
  would establish — adding them changes nothing a browser does. Both checks now
  read the project's CSS (`<style>` blocks and `.css` under `src/` offline;
  the page's linked stylesheets when `--url`) and skip an `<img>` whose class,
  id or inline style puts it at `position: absolute`/`fixed`.

  This is not a corner case, it is the shape rider's *own* advice produces:
  `images: background-image` pushes a site off CSS backgrounds, and the
  replacement it names is precisely an absolutely-inset `object-fit: cover`
  `<img>` — so the more compliant the site, the more of these it has.
  tasmanvisa-web reported 20 of them, **20 of the 21 required findings in the
  whole live run**, on a page rider itself measured at CLS 0.001 (`browser`) and
  0 (`lighthouse`). A heuristic that a measurement in the same run contradicts
  that loudly is a bug in the heuristic. The reader is a selector scan, not a
  cascade — it answers the weaker "does any rule take this out of flow?" and errs
  toward silence, because missing one shifting image costs a finding while crying
  wolf twenty times costs the domain its credibility (`tools/lib/css-flow.mjs`).

  The live finding is also **aggregated**, one line naming a count and an
  example, not one per tag. A shared component puts the same defect on every card
  on the page; twenty findings for one fix is what buried the other one.

- **Render-blocking CSS stays small.** Measured on the *heaviest single page*:
  the bytes of every `<link rel="stylesheet">` it pulls plus its inlined
  `<style>` blocks. Per page, not per `dist/` — Astro emits a stylesheet per
  route, so a 484-page site legitimately has dozens of `.css` files while any one
  page links two, and totalling the directory would punish a site for having
  pages. `💡` over 100 KB, `🔧` over 250 KB. Four real Astro builds measured
  8–25 KB on their heaviest page, so the soft budget has four times the headroom
  a well-built site needs and the hard one only catches an unpurged framework.
  → `perf: css:bytes`
- **Few render-blocking stylesheets.** Each one is a separate round-trip before
  first paint. `💡` over 3 on a single page (the measured sites sit at 1–2).
  House style. → `perf: css:files`
- **Fonts stay light.** Total `.woff2`/`.woff`/`.ttf`/`.otf` bytes in `dist/`:
  `💡` over 200 KB, `🔧` over 500 KB (measured sites: 42 KB and 107 KB). Two
  families is enough for a content site — one for headings, one for body — and a
  variable font covers a whole weight range in one file.
  → `perf: font:bytes`, `perf: font:families` (`💡` over 2),
  `perf: font:faces` (`💡` over 4)

  **Counting `@font-face` needs two corrections**, both found by measuring real
  builds rather than reasoning about them. Blocks are deduped *by content*: Astro
  inlines the same block into every page's `<style>`, so a naive count returned
  2904 for one 484-page site. And Astro's Fonts API emits a second face per
  family carrying fallback metrics, whose `font-family` contains `fallback:` —
  counting those as real families reported both correctly-configured two-font
  sites as having four, which is exactly the false positive that gets a tool
  uninstalled.
- **woff2, not ttf/otf.** Universally supported for years and roughly half the
  bytes. Serving a raw font format to browsers is a defect on anyone's site, so
  this one is universal. → `perf: font:format`
- **Every declared family is one that can actually paint.** A family in
  `fonts[]` whose `cssVariable` never *leads* a `font-family` stack can only
  render if the font ahead of it fails to load — which, for a self-hosted,
  preloaded webfont, means never. It is downloaded eagerly on every page anyway.
  tasmanvisa-web had `Inter` sitting second behind `Sora`: **277 KB**, 143 KB of
  it italic faces nothing referenced. → `perf: font:unused-family`

  Neither this nor the next one shows up in a byte total, which is why
  `font:bytes` passed the whole time: the total was correct, the *composition*
  was wrong. The correct fallback is the metric-adjusted local one Astro already
  generates (`optimizedFallbacks`, on by default), not a second webfont.

  A variable that appears in no stack at all is `💡` rather than `🔧` — the
  weaker evidence of the two, since it could equally be a gap in how the tool
  reads the CSS.
- **A family that never renders italic says so.** `styles` defaults to
  `['normal', 'italic']` — read off `astro/dist/assets/fonts/constants.js` in
  astro@7.1.6, not recalled — so declaring a family without it silently doubles
  its file count. Three of tasmanvisa's four families were shipping italic files
  for nothing. → `perf: font:styles`

  `🔧` only when the built output renders no italic *at all*. `<em>`, `<i>` and
  `<cite>` are italic from the UA stylesheet with no CSS involved, so testing for
  `font-style: italic` alone would flag every blog with emphasis in its prose;
  when any of those is present the finding drops to `💡`.

  **The fix hints name family × style × subset, never "drop unused weights".**
  Weights are free with a variable font — Sora 300–700 is one file — so pruning
  them is wasted effort, and advice to do it would be actively misleading. Nor is
  `subsets` safe to trim on a bilingual site: `latin-ext` is mandatory for
  Hungarian ő/ű.
- **Heavy third-party embeds sit behind a facade.** A Maps, YouTube, Vimeo,
  Spotify, Calendly or Typeform `<iframe>` pulls hundreds of kilobytes over
  dozens of requests from an origin you don't control, and it starts the moment
  the page loads. The fix is a facade: render a static placeholder — an image, or
  a styled box with a play button — and inject the real `<iframe>` from an
  `IntersectionObserver` when the reader scrolls near it. → `perf: embed:eager`

  **`loading="lazy"` is not a substitute, and the check deliberately does not
  accept it.** Native lazy loading only defers frames far enough down the page.
  On cypruspokerbrisbane.com (2026-05-31) the Maps `output=embed` iframe was in
  the *second section* — inside the threshold — so the attribute was present and
  the ~360 KB across ~20 requests was fetched anyway. Under PageSpeed's simulated
  Slow-4G that saturated bandwidth before first paint: mobile Performance 70,
  FCP 3.5 s, LCP 5.5 s. Behind an IntersectionObserver facade the same page
  measured 97 / 1.5 s / 2.0 s.

  Detection is "is the frame in the built HTML at all", because a facade injects
  it at runtime and so leaves nothing to find. Markup a browser does not fetch is
  excluded first — `<template>` (inert, and exactly what a facade clones) and
  `<noscript>` (the correct no-JS fallback *for* a facade) — since flagging those
  would report the fix as the defect. The host table lives in
  `tools/lib/embed-hosts.mjs`; a same-origin or small third-party frame is not
  what this is about.
- **Cross-origin image hosts are preconnected.** A browser only starts DNS + TLS
  for a host once it parses a URL pointing at it, so on a 150 ms-RTT mobile link
  that is several round trips of dead time before a byte of the LCP image moves.
  tasmanvisa-web served every blog hero and card from `media.tasmanvisa.com` with
  no preconnect anywhere: blog index LCP **5424 ms**, ~3500 ms once a preconnect
  plus a matching head preload were added — and the audit reported `perf ✅ all`
  throughout. → `perf: preconnect`

  A host serving one incidental image (an avatar, a badge) is `💡`, not `🔧`:
  the advice is still right, but it is not what cost 900 ms, and failing a build
  over it is the crying-wolf failure `policy.mjs` exists to prevent.
- **A preconnect to an image host matches its images' CORS mode.** A browser
  pools connections by credentials mode. A plain `<img>` is a no-cors,
  credentialed fetch; a `<link rel="preconnect" … crossorigin>` opens an
  anonymous CORS connection that fetch cannot reuse, so the browser opens a
  second and the hint bought nothing. The reverse is just as dead: an
  `<img crossorigin>` with a bare preconnect. It is a separate finding precisely
  because it *looks* fixed — worse than missing. → `perf: preconnect:crossorigin`
  **Corrected 2026-09-02.** Until then this check demanded `crossorigin` on every
  image-host preconnect, on the claim that "images are CORS-mode fetches". They
  are not, unless the tag says so; that rule is right for fonts and `fetch()`
  and wrong for nearly every image on a content site. MDN's preconnect example
  for a generic origin is bare, and the rule it states is *match the resource's
  CORS and credentials mode*. The starter's own media lane tripped it.
- **A preload for an image matches the tag byte for byte.** A head
  `<link rel="preload" as="image">` whose `imagesrcset`/`imagesizes` differ from
  the `<img>`'s `srcset`/`sizes` makes the browser resolve two different
  candidates and download the image twice, so the preload leaves the page slower
  than no preload at all. → `perf: preload:pair`

  **A `srcset` is not `split(',')`, and getting that wrong made this check fire
  on correct code.** A candidate URL may contain commas, and on the delivery this
  baseline recommends it always does:
  `/cdn-cgi/image/width=800,format=auto,quality=80/hero.webp` shattered into
  three fragments, one of which — `format=auto` — was shared by *every*
  transformed image on the page. Pairing a preload to an `<img>` by shared
  fragment then matched an arbitrary unrelated image, whose srcset naturally
  differed, and the check reported a mismatch on a byte-identical pair. Worse, it
  routed around the no-match branch that exists exactly for the reporter's case:
  a preload whose image is a CSS `background-image` has no `<img>` to pair with,
  and "not something a static read can call a defect" was the correct outcome.
  All srcset reading now goes through one spec-shaped parser
  (`srcsetUrls` in `tools/lib/html.mjs`) — a URL is a run of non-whitespace and
  only a *trailing* comma ends a candidate, exactly as a browser reads it.
  Reported by tasmanvisa-web.

  Which page is "cross-origin" is decided per page from its own canonical link
  (falling back to `site:` in astro.config): a page declaring neither is not
  counted, because guessing the site's origin from the build would invent
  findings on a site that renders absolute self-URLs.
- **`sizes` describes the box, not the ambition.** `sizes`, not the layout, is
  what picks the srcset rung — so `sizes="100vw"` on a card that renders at
  355 px in a 393 px viewport makes the browser fetch 1280w/167 KB where
  1000w/133 KB was correct. This needs a rendered measurement, so it lives in the
  `browser` domain: when an image is served far larger than its box *and* its
  `sizes` claims the full viewport, the finding names the attribute as the cause
  rather than reporting the bytes as the symptom. → `browser: images:rendered-size`

## content — pages a site is repeatedly asked for

*Check file: `tools/checks/content.mjs`. Reads built `dist/` HTML, so any routing
convention counts — detection is on what the page renders, not its filename.*

The two *page* practices here are **house style**. A personal Astro blog is not
broken for lacking either, and a tool that says otherwise gets uninstalled. They
report `💡 [baseline]` by default and bind under `--strict`. The credit practice
at the end of the section is not house style and does not move with `--strict`:
it fires only on a site that has itself declared it is built from someone else's
material.

- **A media kit.** A small business or project site is regularly asked for "your
  logo and a short description". Without one canonical page that becomes an email
  thread and inconsistent assets in the wild — the wrong logo, a stale
  description, someone's screenshot. It is the one URL you hand to press,
  partners, sponsors and directories. A route matching `/media`, `/media-kit`,
  `/press`, `/presskit`, `/newsroom` or `/brand-kit` must carry three things to be
  worth linking: a downloadable logo asset, a paste-ready paragraph of
  boilerplate, and a contact route or `mailto:`.
  → `content: mediakit` (`⏭` with no `dist/`)

  **The route list is the check's weak point, and it has failed once.**
  tasmanvisa-web got a `🔧` for a missing media kit while serving a full
  bilingual one at `/media/` — the single plain-English name that was not in a
  list of three (issue #17). Two things came out of that. Bare `/media` is now
  accepted, and with a **locale-prefixed translated slug** the name list can never
  be the answer: `/hu/sajto/` matches nothing in English however long the list
  gets. So the check reads the `hreflang` alternates a matching page emits and
  accepts those pages too — the site already declares which pages are each
  other's translations, for search engines, and reading that beats a per-language
  dictionary of the word "press". Broadening a name list also means a page can
  match the *route* and not be the thing (`/media/` as a photo gallery), so among
  several matches the **best** candidate decides, never the first one the walk
  hits: otherwise a site's real media kit gets reported as "page exists but is
  missing a downloadable logo asset", which is a wrong finding rather than a
  missed one.
- **A design reference page.** This is the one that pays off for the agent
  audience. A `/design` (or `/styleguide`, `/design-kit`, `/tokens`) route that
  renders the site's *actual* tokens and components — colours, type scale,
  spacing, buttons, cards, form controls — lets an agent or a new contributor see
  what exists and where it is used without reading every component file. It also
  makes drift visible: rendered from the real tokens, a divergent hardcoded
  colour shows up next to the swatch it should have matched.

  The check asks only that the route exists and renders more than a heading —
  design tokens referenced, colour swatches, or several component sections.
  Detection is deliberately loose, because the risk here is false-positiving on a
  legitimate variant. The strongest version of this page generates itself *from*
  the token source so it cannot drift, but that is site-side work: the auditor
  checks the page is there and is not a stub, and does not try to generate it.
  → `content: designkit` (`⏭` with no `dist/`)
- **Quotes are written, not guessed at.** Astro 7 renders Markdown with Sätteri
  instead of remark, and the two resolve an *ambiguous* straight `"` differently.
  On tasmanvisa-web's Hungarian content the closing quotes flipped to opening
  ones: six posts shipped `„bespoke“` where the pairing is `„…”`. Nothing in the
  build said a word. Writing the quote you mean fixes it permanently, for any
  engine. → `💡 content: quotes:ambiguous`

  **Advisory in every mode** (`policy.mjs` `ADVISORY`, no `🔧` branch at all).
  Correct prose can legitimately mix a straight quote with a directional one — an
  inch mark, an attribute quoted mid-sentence — so this is the one check here
  that can fire on a compliant site, and a check that fails a compliant site is
  what this repo refuses to ship. It reports *where the two engines would
  disagree*; whether that is a bug is the author's call.

  Fenced code and inline backticks are excluded first: no engine touches those,
  and a `const a = "x"` on a page about typography would otherwise be a finding.
  Markdown is found by walking `src/`, not `src/content/` — the starter keeps its
  posts in `src/data/blog/`, and hardcoding the other path is the mistake that
  once made a whole SEO domain silently not run.
- **A site built from someone else's material credits it, visibly, on the pages
  that use it.** Create mode can be handed a brief that arrives with content
  already written and sourced — public-domain and CC0 works, under a licence that
  requires the work, the author and the licence to be named where a reader can see
  them. `src/data/sources.json` is where a site records that, the starter ships it
  empty, and `components/Sources.astro` renders it from the root layout, so every
  page carries the block rather than each page remembering to.
  → `content: sources:credited` (`⏭` when the file is absent or names nothing)

  **What the check proves is narrow on purpose: the credit was not dropped.** Every
  work the site names must appear in the built HTML — script and style bodies
  blanked first, entities decoded, so a title shipped inside a JSON blob does not
  count as a credit anyone can read. It says nothing about where the block sits or
  how it reads, because that is a judgement and this is not. The failure it exists
  for is mechanical and common: a credit block is the first thing to go when a page
  is tightened up, and nothing else in a build notices.

  **A block that is honest about being incomplete beats one that looks finished.**
  The content this was written against carries work titles and a count of the works
  a page drew on — and no author, no licence and no link per work. So the block
  names what it has and states plainly what it does not, and rider does not infer
  an author from a title. Filling that in would invent the one thing a credit block
  exists to state, and it would be invisible: a complete-looking credit is exactly
  what nobody re-checks. The gap is upstream's to close, and asking for it is a
  smaller job than papering over it.

## data — the machine-readable surface

*Check file: `tools/checks/data.mjs`. Source: `src/components/SEO.astro`,
`src/lib/jsonld.*`, `src/pages/**`, `src/content.config.ts`. Endpoints are matched
by **pattern**, so single-locale and per-locale naming both pass.*

- **Every collection is schema-validated**, not just one of them. The check was
  a whole-file `/z\.object\(/` on the raw text of `content.config.ts`: two
  collections where only one had a schema passed, and so did a file whose only
  mention of Zod was in a *comment* — the exact failure mode this repo had
  already fixed for meta tags and then repeated here. All five dogfood builds
  found it. Now: comments blanked, each `defineCollection` body checked for a
  `schema:`, and the unschema'd ones named. → `data: content:schema`

  **Blanking comments requires knowing what is a comment**, and the regex that
  did it read a `/*` inside a *string literal* as an opener. The carrier is the
  single most idiomatic line in a Content Layer config —
  `loader: glob({ pattern: '**/*.md' })` — so the blanking ran from the glob
  pattern to the next real `*/`, swallowing the `schema:` key a few lines below
  and reporting a ~35-field Zod schema as absent. It needs *both* halves to
  fire, which is why every two-line test of it looked fine. The scanner is now
  string-aware (`stripComments` in `tools/lib/src-scan.mjs`), and string state
  resets at each newline on purpose: an apostrophe in `.astro` prose ("don't")
  is not a string opener, and letting one span lines would suppress comment
  stripping for the rest of the file — reintroducing the
  comment-satisfies-a-check failure above, which is the worse of the two.
  The blast radius was every `src-scan` consumer, not this check alone.
  Reported by tasmanvisa-web.
- **JSON-LD emitted, covering both core shapes.** The built pages carry
  `application/ld+json` with an Article-family type per post and a site-wide
  `WebSite`. Read from `dist/` and **parsed**, not grepped: the old check required
  a file at `src/lib/jsonld.ts` containing the literal string `BlogPosting`, so
  five independently built sites that all emit rich, valid JSON-LD were all told
  they had none — they named the module differently, inlined it, or chose
  `Article`. Any of `Article`, `BlogPosting`, `NewsArticle`, `TechArticle`,
  `ScholarlyArticle`, `LiveBlogPosting`, `Report`, `CreativeWork` counts; all earn
  the same rich results. `@graph` and top-level arrays are unwrapped.
  → `data: jsonld:emitted`, `data: jsonld:shapes` (`⏭` with no `dist/`)
  Coverage uses the sitemap denominator too. "More than zero" was the old bar:
  one page out of nineteen reported ✅ and exit 0, printing a ratio with no
  threshold to read it against.
- **The JSON-LD parses.** A block that isn't valid JSON is discarded whole by
  search engines while looking perfectly fine in the source — worse than emitting
  none. → `data: jsonld:parses`
- **The Article node carries the properties Google documents.** Reading the
  `@type` and stopping is where structured-data checking usually ends, and it is
  not enough: a `BlogPosting` whose `author` is a bare string, whose `image` is
  relative and whose `datePublished` is `toLocaleDateString()` output declares
  itself correctly and earns nothing. Google reads the type, finds the properties
  unusable, and drops the rich result — no error in the page, none in Search
  Console, none in an audit that only counted types. Google marks none of them
  required — "There are no required properties; instead, add the properties
  that apply to your content" — so the split below is this tool's, not
  Google's. `author` and `headline` are the floor it holds a post to, because an
  Article with neither has nothing to attribute and nothing to show; `image` and
  `datePublished` visibly change the result (no image is no thumbnail, no date
  is no date), so their absence is a suggestion rather than a finding.
  → `data: jsonld:article-props`
  **No headline length is asserted.** Google removed the 110-character limit on
  2023-01-03 and now says only that long titles may be truncated on some devices.
  A check for a limit that no longer exists would flag compliant pages.
- **The author is a typed Person or Organization.** `"author": "Jane Doe"` is the
  most common way to write this wrong and it is invisible to any check that only
  asks whether the property is present — a bare string cannot carry the `@type`
  that distinguishes a person from a publisher. An array of authors is correct
  and passes; Google's own example is one. → `data: jsonld:author`
- **Dates are ISO 8601.** A formatted date is not a date to a parser. A date with
  no time (`2026-01-05`) is legal ISO 8601 and passes; the offset is recommended,
  not required, so its absence is not a finding. → `data: jsonld:dates`
- **A breadcrumb trail on content pages.** It is what puts the site's hierarchy
  in the result instead of a bare URL. *Wanting* one is house style — a flat blog
  has no hierarchy to describe — so presence is demoted by default and required
  under `--strict`. Being **malformed** is not house style, and is a separate
  check: positions must run 1..n in order and every item needs a name, because
  Google drops the whole list rather than guessing when either is wrong. The last
  item may omit its `item` URL, where Google defaults to the current page — the
  naive version of this check fires on Google's own documented example.
  → `data: jsonld:breadcrumb` (house), `data: jsonld:breadcrumb-shape` (universal)
- **Absolute URLs, as advice only.** A relative URL in JSON-LD is *not* broken,
  and an earlier draft of this check said it was. JSON-LD 1.1 resolves relative
  IRIs against the base IRI, which for a block embedded in HTML is the document's
  own location, so a compliant processor reads `/og/default.png` exactly as
  intended. Google documents no rule either way — grepping `sd-policies`,
  `intro-structured-data`, `article` and `breadcrumb` for "absolute" and
  "relative URL" returns nothing, and what *is* documented is that image URLs
  must be crawlable, which is a different property. So this is advisory in every
  mode: absolute values survive syndication, a feed, or any reader that never saw
  the page; relative ones work only while the block sits on its original URL.
  → `data: jsonld:urls` (advisory)
- **No markup for rich results that no longer exist.** Three were retired while
  the markup requesting them stayed valid, so sites keep emitting them and keep
  believing they do something: the **sitelinks searchbox** (`WebSite` →
  `SearchAction`, removed from results 2024-11-21), **HowTo** (desktop results
  ended 2023-09-13), and **FAQPage** (restricted to authoritative government and
  health sites in September 2023, retired outright 2026-05-07). All three doc
  pages now redirect to their removal entries in Google's changelog. Google is
  explicit that removing them is optional and that leaving them causes no errors,
  which is exactly why this reports and never fails — the markup is not wrong, it
  is just no longer paid for. `--strict` does not promote it; there is no failing
  branch to promote. Only the `SearchAction` is dead, not `WebSite`, which still
  carries the site name. Our own fixture was emitting one, which is how this
  check earned its keep on the day it shipped.
  → `data: jsonld:deprecated` (advisory)
- **`/llms.txt`, content-driven.** Some `llms*.txt` endpoint is built from
  `getCollection()` (a multi-locale root may be a thin index pointing at
  per-locale variants — pass if *any* endpoint is content-driven). →
  `data: llms.txt`
- **Published-only filter on the content index.** Drafts and preview-only
  entries must be excluded — accepted as inline `!draft && !previewOnly` *or* a
  factored `isPublished()`-style helper. → `data: llms.txt:filter`
- **RSS feed with items in it.** Judged on the built `rss*/feed*/atom*.xml`:
  does it contain `<item>`s? The endpoint file is only how the feed got there, so
  requiring `getCollection()` *inside* it penalised the better pattern of
  factoring the collection query into a shared helper. Without a `dist/` the
  endpoint's existence is reported, and the message says its output is unverified.
  → `data: rss`
- **A search-index endpoint, if the site has search *and the engine reads one*.**
  A `search-index*.json` endpoint built from `getCollection()` is what a
  client-side engine loads. Since search became optional the check is
  dependency-aware: no endpoint *and* no search library is `⏭`; no endpoint
  *with* an index-reading library installed is a finding, because the site ships
  a search UI with nothing to feed it.

  ⚠ **"Has search" is not the same question as "emits an index".** Pagefind
  indexes the *built HTML in `dist/`* as a build step; Algolia, Meilisearch and
  Typesense keep the index on a server. Asking any of them for a
  `search-index.json` endpoint is asking for a file the engine is designed not to
  have — and the check did, on correct sites, until each engine started carrying
  a `localIndex` fact alongside its packages. An engine that hosts or builds its
  own index now `⏭`s and says which it does. → `data: search:index`
  (pairs with `modules: search:engine`)

**Shared invariant:** one publish predicate — `!draft && !previewOnly` — across
llms, RSS, and search-index, so all three discovery surfaces agree on what's
public.

## analytics — measured privately, and measured at all

*Check files: `tools/checks/analytics.mjs` (offline: source + built `dist/`) and
the `analytics` checks in `tools/checks/live.mjs` (served HTML, `--url`). The
patterns both read live in `tools/lib/analytics-signals.mjs`, so the two cannot
drift.*

**Nothing in this section fails a run.** `analytics: provider` is *advisory by
construction* — it has no `🔧`/`🛑` branch at all, in either mode, and
`tools/lib/policy.mjs` lists it as such so `--rules` says `[advisory]` rather
than implying `--strict` would promote it. Whether a site measures its traffic
is a business decision. The tool reports what delivers analytics — including
when the answer is nothing — and moves on. `tools/test.mjs` asserts the
invariant under `--strict`, because a future refactor could otherwise turn every
unmeasured site into a build failure without a single test going red.

### The default: Cloudflare Web Analytics

- **Cloudflare Web Analytics is the baseline's analytics layer.** It is free, it
  is cookieless, and it does not require a consent banner — so a site can be
  measured the day it deploys, with no dashboard project in front of it. One
  script tag in the root layout:

  ```html
  <script type="module"
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "<SITE_TOKEN>"}'></script>
  ```

  (Cloudflare `web-analytics/faq`, verified 2026-08-03. A `?token=…` query-string
  form exists too, for tag managers that cannot set attributes.) The beacon
  reports to `/cdn-cgi/rum` on the site's own origin.
  → `analytics: provider`
- **Offline can only ever be advisory about its presence, and not because of the
  severity.** For a proxied site Cloudflare injects the beacon *at the edge* —
  automatic setup is on by default — so a correctly-measured site can have no
  trace of it in `src/` or `dist/`. The served page is the authoritative reader.
  The offline check therefore says what it saw and names `--url` as the thing
  that settles it, rather than concluding.
- **A beacon wired behind an unset token measures nothing.** The common shape is
  a root layout that renders the script only when a token is configured. That is
  correct — but it means "the code is there" and "data is flowing" are different
  claims. When the beacon is in `src/` and in none of the built pages, the check
  says so in those words. `examples/_fixture-i18n` is the standing example: it is
  localhost-only, its token is genuinely `null`, and it carries this `💡`
  permanently rather than being given a fake token to look clean.
- **Auto-install does not reach a Worker.** Cloudflare's automatic injection
  rewrites HTML for proxied *static* responses. A site served by a Worker — which
  is what a Cloudflare Pages/Workers deploy of an Astro build is — is not
  rewritten, so auto-install silently does nothing and the dashboard still shows
  the site as set up. **On a Workers-served site the `<script>` in the root
  layout is mandatory.** This is the single most expensive thing to get wrong
  here, because every surface reports success: the dashboard says installed, the
  build says fine, and no data arrives. Confirm it the only way that means
  anything — `--url` against the deployed site, which reads the served HTML.
  → `analytics: provider` (live)

### The alternative, fully supported: Cloudflare Zaraz

Zaraz is a tag *manager*. Reach for it when you need to run Google Analytics or
other third-party tools and want them gated behind a consent CMP. It is not
worse than Web Analytics; it is a bigger thing, and it is no longer what a site
must set up before it measures anything.

- **Zaraz loads tags at the edge, behind its own consent gate.** It loads Google
  Analytics (and Cloudflare's own analytics) at the edge and holds every tag
  behind its Consent Management Platform — the cookie banner — so nothing fires
  before the visitor agrees. → `analytics: zaraz` (live)
- **The Zaraz loader is only visible at serve time.** Because Zaraz injects at
  the edge, the loader (`/cdn-cgi/zaraz/i.js`) shows up only in served HTML. With
  `--url`, its presence confirms analytics is Zaraz-managed. Without `--url` the
  check reports `⏭`, and says which.
- **The live probe must look like a browser to see Zaraz.** Zaraz has a "Block
  bot initiated requests" setting (bot-score based: block none / automated /
  automated + likely) and Bot Fight Mode does the same — a headerless `fetch` is
  bot-scored as automated, so the edge *correctly* suppresses the loader
  injection for it. A curl-shaped probe therefore never sees Zaraz on a protected
  site, even when it is configured right. So the live GET carries a full browser
  navigation signature (`NAV_HEADERS` in `live.mjs`: Chrome UA, `Sec-Fetch-*`,
  `Sec-Ch-Ua`, `Accept: text/html…`) to get the fully-injected page a real
  visitor receives. Without this the check skips with a false negative.
  → drives `analytics: zaraz`
- **The cookie banner is Zaraz's CMP — no custom banner in the site.** Zaraz
  ships a built-in Consent Management Platform: enable it in the dashboard,
  assign each tool a *purpose*, and Zaraz auto-renders the consent modal, gates
  every tag until the visitor agrees, localises by `Accept-Language`, and is
  styleable via custom CSS. So a site using Zaraz should **not** hand-roll a
  cookie banner — that duplicates what the CMP already does and risks tags firing
  outside consent. The Consent API (`zaraz.consent.*`, the `cf_consent` cookie,
  the `zarazConsentAPIReady` event) is the escape hatch *only* for advanced needs
  — region-scoped modals (e.g. EU-only) or integrating a third-party CMP. (No
  enforcing check: a custom banner isn't reliably detectable in static HTML, and
  the CMP render itself is a Gap below — runtime, needs a browser.)
- **A site on Web Analytics needs no banner at all.** This is the practical
  reason it is the default: cookieless measurement has nothing to consent to, so
  the entire CMP question — build it, configure it, style it, test that tags
  actually hold — does not arise.

### The finding: a snippet that fires before consent

- **No hardcoded Google Analytics / GTM snippet.** A GA or Tag Manager snippet
  pasted into the source fires immediately, outside any consent gate, and
  bypasses Zaraz entirely. The offline check flags it
  (`gtag.js`/`gtm.js`/`analytics.js`/`gtag(`/`GTM-…`/`UA-…`) in `src/` or
  `dist/`. It has two fixes, and the check names both: drop GA for cookieless Web
  Analytics, or deliver GA through Zaraz so the CMP gates it.
  → `analytics: no-hardcoded-ga`
- **Live, only a third-party *loader* counts.** A bare `gtag()` call is not
  flagged against served HTML: when Zaraz delivers GA it injects that bootstrap
  into the rendered page itself, so keying on the call — as the offline scan
  correctly does for *source* — would flag every compliant site. Only a script
  fetched from a Google origin proves the site went around the edge. That is its
  own rule in both branches: reporting the no-Zaraz case under the `zaraz` id
  gave one id three meanings, so nothing could be filtered or suppressed by it.
  → `analytics: ga:raw`
- **Comments are blanked before matching.** A `{/* Cloudflare Web Analytics
  beacon */}` note above an unwired block must not satisfy the *positive* check —
  that would be the tool reporting verified-good where nothing is emitted, which
  is the worst failure it has. The check reads `code` from `lib/src-scan.mjs`,
  not raw text. This class of bug has now been fixed three times in this repo
  (meta tags, then content schemas, then here), which is why it is written down.

> **Not enforced: Google Tag Gateway.** Cloudflare's Google Tag Gateway (serving
> the Google tag first-party from a reserved path instead of `googletagmanager.com`)
> earns its keep when ad-spend measurement / ad-blocker signal recovery is the
> point — paid acquisition, conversion optimisation. For a content/info site that
> signal isn't acted on, so the gateway is overkill: a per-zone moving part to
> maintain for no payoff. First-party serving is a deliberate non-goal, not a
> gap. (Considered + dropped 2026-05-30.)

> **Manual setup (operator step, not in the repo).** Both deliveries are
> configured in the Cloudflare dashboard, per zone: for Web Analytics, creating
> the site and getting its token; for Zaraz, the tools it loads, the property ID,
> the consent CMP config, auto-inject, and the bot-request policy. None of it
> lives in the audited site's source, so the audit can only *verify it is present
> and firing* at serve time (`--url`); it can never provision it. Treat it like
> the PSI key: an operator manual setup the tool checks, not one it owns.


## live (`--url`) — what only exists at serve time

*Check file: `tools/checks/live.mjs`. Hits a running/deployed URL.* Re-verifies
the source-level practices against reality: reachability, the real `Cache-Control`
headers, served image bytes (with a browser `Accept`) and transform params, the
rendered SEO surface + JSON-LD on home and a content page, and `/llms.txt`
(served, has an H1, grouped/indexed). Page fetches carry a full browser
navigation signature so edge logic gated on bot score — notably the Zaraz loader
injection — behaves as it does for a real visitor (see `analytics`). Point `--url`
at `wrangler dev` of `dist/` or the deployed site — a plain `astro dev` won't have
the cache headers.

- **The content page is discovered, not assumed to be under `/blog/`.** Order:
  the sitemap (the site's own declaration of its URLs) → same-origin `<a>` links
  on the homepage → `/llms.txt`. Index routes, pagination, tag/category listings
  and non-page extensions are excluded, and the deepest remaining path wins — a
  leaf article over a section landing page. The old check matched `/blog/` only,
  so five sites using `/projects/` and `/wiki/` had ~10 live checks silently not
  run, and two runs printed "audit clean — exit 0" having checked almost nothing.
- **A skip names what it skipped.** When no content page can be found, the `⏭`
  lists the rule ids that did not run. Silence must never be indistinguishable
  from a pass. → `seo: post`
- **The sampled page is one the site itself calls an article.** Discovery reads
  the **feed first** — RSS/Atom is the site's own list of what it considers a
  post — and only falls back to the sitemap, homepage links and `/llms.txt`. The
  sitemap lists every indexable page equally, so "deepest path wins" picked
  whatever sorted first: on matewishkey-web that was `/glossary/agent/`, while
  the `BlogPosting`-carrying `/projects/*` sat right beside it in the same
  sitemap.
- **A page type that isn't an Article is not a missing Article.** A glossary
  entry is a `DefinedTerm`, an FAQ is an `FAQPage`, a recipe is a `Recipe` —
  each is the *correct* markup, and rewriting it as an Article would make the
  page worse. `data: post:jsonld` passes on any of them and says which was
  found, so "this is a definition" and "this is a post" stay distinguishable.

  The generic wrappers are deliberately **not** accepted — `WebPage`,
  `WebSite`, `BreadcrumbList`, `Organization`. They say nothing about what the
  page is, so accepting them would collapse this check into "has any JSON-LD",
  which `jsonld:emitted` already answers. The list lives in
  `tools/lib/jsonld.mjs` (`CONTENT_PAGE_TYPES`). Reported by matewishkey-web.
- **A finding that could not have gone the other way is not a finding.** Neither
  `astro dev` nor `astro preview` applies `public/_headers` — both serve
  `/_astro/*` as `no-cache` whatever the file says — so `perf: cache:_astro`
  against one was guaranteed, unactionable, and (under `--strict`) run-failing.
  It now `⏭`s when the project's own `_headers` declares hashed assets immutable
  *and* the server is local *and* it returned otherwise: three facts that
  together mean "this server ignores the file", not "this site is misconfigured".

  Being local is deliberately not sufficient. `wrangler dev` of the same build
  returns `public, max-age=31536000, immutable` (measured, 2026-08-03, wrangler
  4.118.0 against `examples/starter`), so skipping on host alone would hide the
  finding on the one local server able to produce it. For the same reason the
  *pass* carries no dev-server caveat: an immutable response is something only a
  server that applied the rule can return, so it is proof wherever it came from.
  The caveat now attaches to `perf: cache:html` only when the asset probe showed
  the server ignoring `_headers`.

- **The canonical URL answers directly.** A `<link rel="canonical">` is a claim
  that this exact string is the page's address; a canonical that redirects is a
  claim the server contradicts. Found on the starter itself on 2026-09-02: Astro
  builds `about/index.html` and declares `trailingSlash: 'never'`, so every
  canonical was `/about`, and Workers' default `assets.html_handling`
  (`auto-trailing-slash`) serves a folder index only at `/about/` and answers
  `/about` with a 307. Every canonical on the site redirected, and the live audit
  said clean, because every fetch it made followed redirects. A search engine
  that follows it indexes the slash form the site never declares; every shared
  link pays a round trip first. The obvious fix — `assets.html_handling:
  drop-trailing-slash` in `wrangler.jsonc` — does nothing here: the adapter
  regenerates the assets block into `dist/server/wrangler.json` at build and
  drops the key (measured, wrangler 4.118; the dev log says "Using redirected
  Wrangler configuration"). The fix that holds is on Astro's side:
  `build.format: 'file'` emits `about.html`, which the host serves at `/about`
  directly and redirects `/about/` and `/about.html` to. Its one side effect is
  that `Astro.url.pathname` then carries `.html`, so the starter strips it in
  the single place a page declares its own URL. Fetched with redirects
  *disabled* on the homepage and the content page, re-rooted onto the audited
  origin. → `seo: canonical:direct` (live)

## lighthouse (`--url`) — the measured score

*Check file: `tools/checks/lighthouse.mjs`. Needs a PSI key.* Where the static
checks confirm "is it wired right?", this answers "what's the real score?" —
PageSpeed Insights Performance/SEO/Accessibility/Best-Practices + lab Core Web
Vitals (LCP/TBT/CLS), plus CrUX field data when the site has enough traffic.
Lab scores are noisy — treat one run as a sample, not a verdict.

- **A score comes with what it means.** "Lab noise" is a real answer and also a
  dangerous one: cypruspokerbrisbane's 5.5 s LCP was dismissed as a harness
  artifact when the cause was a 360 KB Maps iframe. Pulling the full PSI JSON
  settled it in one read, so the three fields that settled it are reported
  instead of discarded — the **LCP element** (what the number is waiting for),
  the **heaviest third-party origins** (weight the site owner did not write), and
  **simulated vs observed** FCP/LCP.
  → `💡 lighthouse: lcp:element`, `third-party:payload`, `metrics:observed`

  The pair is what tells the two cases apart. ~0 ms TTFB with a high FCP means
  the render is blocked by *payload* — go looking for an embed. A completed load
  with an idle main thread but a late **observed** paint is harness variance, and
  the proof in that case was that observed FCP got *slower* after the page got
  lighter.

  All three are advisory by construction (`policy.mjs` `ADVISORY`): they are
  facts about the run, not verdicts. The scores beside them are the verdict.

  **Audit ids are read under both the current and the legacy names, and that is
  load-bearing.** Lighthouse renamed this family to `*-insight`, and PSI serves
  whatever its deployed Lighthouse emits. Measured 2026-08-03 against a live key:
  the response carried `lcp-discovery-insight`, `lcp-breakdown-insight` and
  `third-parties-insight`, and **none** of `largest-contentful-paint-element` or
  `third-party-summary`. The failure mode is the quiet one — a renamed id doesn't
  error, it produces a permanent `⏭`, which reads exactly like "nothing to report
  here". Both id sets are parsed and both are asserted in `tools/test.mjs`.

  The insight shape pays for itself: `lcp-discovery-insight` also carries a
  checklist of the three things that delay an LCP image regardless of its bytes —
  `fetchpriority=high` applied, not `loading="lazy"`, discoverable in the initial
  document. Failures are quoted in Lighthouse's own words rather than re-worded,
  since it is the authority on its own check.


## browser (`--url`) — what only a real browser sees

*Check file: `tools/checks/browser.mjs`. Needs `playwright` installed in the
audited project.* Every other domain reads bytes — source files, built HTML, or
the HTML a server hands back. A page is not its bytes. A script that throws, an
asset that 404s only once the page asks for it, an image downloaded at 4× the box
it lands in, the layout jumping as a font swaps: none of that is in the response,
and all of it is what users actually report. This domain loads the page in
Chromium and measures what happened.

- **`playwright` is deliberately not a dependency of this tool.** It is imported
  dynamically, and the whole domain `⏭`s with the install command when it isn't
  there — the same shape as `lighthouse` without a key. `git clone && node
  audit.mjs` has to keep working with no install step and no browser download; a
  headless Chromium is ~150 MB and cannot be the price of an offline SEO check.
  Resolving from **the audited project** is the load-bearing half: rider is
  normally a clone somewhere else entirely, so a bare `import('playwright')`
  looks in the wrong `node_modules` and reports "not installed" about a project
  that installed it. Playwright's entry is CommonJS, so its exports arrive on
  `default` under ESM — destructuring `{ chromium }` yields `undefined`, which is
  indistinguishable from absent. Both resolutions are tried, and both spellings
  read. → `⏭ browser: playwright`, `browser: launch`

  **This is the tool's one exception to "never executes the audited project's
  code", and it is disclosed rather than hidden.** Importing a driver out of the
  project's `node_modules` means a hostile repository can reach the auditor
  process — which four documents flatly denied until issue #19. The exception is
  bounded: `--url` only (the offline audit never gets here), the auditor's own
  tree is resolved **first** so a project copy loads only when there is no other,
  and the run announces which copy it loaded. Distrust the repo? Omit `--url`.
  → `⏭ browser: playwright:source`, and `SECURITY.md`
- **A measured page is one page, and the output says which.** Everything below
  is measured on the single URL that was loaded, so the domain announces it up
  front rather than letting a homepage sample read as a site-wide verdict. Pass
  `--post <path>` to measure a content page instead. → `⏭ browser: scope`
- **It is measured at a phone's width, because that is what `--strategy` already
  claimed.** Lighthouse has always defaulted to `mobile`; this domain used to
  take Playwright's default and measure at 1280×720 regardless, so one run
  reported a mobile score and a desktop measurement and never said so. Worse,
  `--strategy desktop` silently did nothing here. Both viewports now come from
  the flag (`mobile` 393×852, `desktop` 1280×800), `isMobile` is set so the
  page's `<meta viewport>` and the `pointer`/`hover` media queries behave the way
  a phone reads them, and the scope line prints the width it used. A CLS number,
  an oversized-image ratio and a third-party weight are all viewport-dependent —
  a measurement that does not name its viewport is not a measurement.
  → `⏭ browser: scope`
- **Nothing is measured until the page actually loads.** A navigation that times
  out, hangs on a pending request, or returns a non-2xx is a `🛑 block`, not a
  quiet run of zero findings — a domain that reports "no errors" about a page it
  never opened is the failure this whole file exists to prevent.
  → `browser: load`
- **An uncaught exception is a defect even when the HTML is perfect.** A script
  that throws leaves buttons dead, menus shut and forms inert while every static
  check still passes: the markup it was supposed to animate is right there. It is
  a `🔧`. Console errors are a separate, softer signal — each one is something
  the page tried to do and could not, but plenty are third-party noise, so they
  are `💡`. → `browser: js:errors` (`🔧`), `browser: console` (`💡`)
- **A request the browser could not complete is a missing asset.** 404s on
  sub-resources are invisible to a static read — the HTML referencing them is
  well-formed, and only fetching the page's own request list finds them. A
  connection-level failure is reported differently on purpose: it may be the
  network the audit ran on (an ad blocker, a DNS filter, a captive portal), not
  the site, and the fix text says to re-check from elsewhere before treating it
  as a site bug. Blaming a site for the auditor's network is how a tool loses
  trust. → `browser: requests`
- **"Oversized" means oversized *for its box*, which only a browser knows.** The
  offline checks compare bytes to a fixed budget; a 1280w hero is fine and a
  1280w thumbnail is not, and nothing in the bytes distinguishes them.
  `naturalWidth` over the rendered width does. Over 2.5× is reported.

  The finding names the **cause, not the symptom**, when it can see it: `sizes`
  — not the layout — is what picks a srcset rung, so an overstated `sizes` is
  usually the whole explanation. tasmanvisa-web claimed `100vw` for a card
  rendering at 355 px in a 393 px viewport, and the browser dutifully fetched
  1280w/167 KB where 1000w/133 KB was correct. Advisory: the ratio is a
  heuristic, and art direction can justify it. → `💡 browser: images:rendered-size`
- **Measured CLS outranks inferred CLS.** `perf: cls:img-dimensions` and
  `images: cls` infer shift risk from missing `width`/`height`. This is the real
  number, from `PerformanceObserver`, and it includes what the static reads
  cannot see at all: font swaps, late-injected DOM, embeds that resize
  themselves. Graded on the Core Web Vitals bands (good ≤ 0.1, poor > 0.25).

  When the two disagree, the measurement is the one that is right, and the
  disagreement is a bug in the heuristic. That is not hypothetical: 20 static
  `images: cls` findings landed on a page this check measured at 0.001, all on
  absolutely-positioned fill images that cannot shift anything. The heuristic now
  reads the CSS — see `perf` above and `tools/lib/css-flow.mjs`.
  → `browser: cls:measured`
- **A third party is a domain you don't own, not an origin that isn't this one.**
  `media.example.com` serving your own images is not third-party weight; counting
  it as such would flag the cross-origin image host `perf: preconnect` exists to
  recommend. The comparison is on the registrable domain (approximated —
  this tool ships no Public Suffix List). Over 250 KB per origin is reported,
  advisory: third-party weight blocks your own content, but the call on whether
  a given tag is worth it is the site owner's. → `💡 browser: third-party`
- **Every route the wide nav offers has to be reachable on a phone.** This is
  the failure nothing else in this file can see. The HTML carries the links, no
  request fails, nothing throws, CLS is clean — and below the breakpoint the CSS
  hides the bar while the control meant to bring it back is missing, unstyled or
  empty. Every static check reads perfect markup; the page has no navigation on
  a phone. That is how a broken hamburger ships, and it shipped.

  It is judged as **reach, not presence**, which is the whole design. A link
  that leaves the bar and turns up in the footer is still reachable, and moving
  it there is a normal, deliberate call — a check that flagged it would be
  uninstalled within a week. So the comparison is: the visible nav links at
  1280px, against everything visible *anywhere on the page* at 393px, after
  opening whatever in the header looks like a menu (`<details>` by property, a
  toggle carrying `aria-expanded`/`aria-controls`, a checkbox hack). Only a
  route reachable from **nowhere** is a `🔧`.

  ⚠ **The visibility test is the load-bearing part, and the obvious one is
  wrong.** Chromium skips a closed `<details>`'s subtree with
  `content-visibility` rather than zeroing its boxes, so the links inside a
  collapsed hamburger measure 58×17 and a bounding-rect test reads them as on
  screen — a menu that never opens would score a clean pass, which is precisely
  the bug. `Element.checkVisibility()` answers correctly (verified both ways
  against an open and a closed `<details>`, 2026-09-01). `tools/test.mjs` asserts
  the pass came *with* a control actually opened, so the regression cannot
  return quietly.

  Two more ways to invent a finding out of nothing, both of which fired before
  they were fixed, and both on pages that were **fine**: `/about` and `/about/`
  are one route that a nav and a footer routinely spell differently, so the
  comparison normalises the trailing slash; and a form's submit button carrying
  `aria-controls` matches the toggle test exactly, so clicking it navigated away
  and left every link looking unreachable. Buttons bound to a form are never
  clicked, and if the URL moves anyway the check reports that it could not tell
  rather than guessing. **The bar for this check is not "does it catch a broken
  hamburger" — it is "does it stay silent on the hundreds of correct ones".**
  ⚠ **Waiting for a menu is waiting for its LINKS, not for the page to go
  quiet.** A menu is often built by script after it opens, and "has the DOM
  stopped changing" cannot tell a page that has not started from one that has
  finished — both look settled on two consecutive polls. Measured: a menu whose
  links were injected 600 ms after the click settled instantly at zero links and
  was reported unreachable. The wait polls for the links the verdict is made of
  instead, stopping the moment they are all present, so only a menu that never
  delivers pays the full budget. → `browser: nav:reach`
- **Console text and asset URLs are written by the page being audited.** They
  land in whatever reads this output, agent or human, so they are truncated and
  fenced like every other untrusted string the tool relays.
  → `⏭ browser: untrusted-input`

## Gaps / candidate practices (not yet enforced)

The queue. Each becomes a real check when a reporter hits it or we decide it's
worth it — following *How we add a practice* above. Listed so we don't lose them.

**The live queue is the issue tracker**, not this list:
[promptityourself/piy-rider issues](https://github.com/promptityourself/piy-rider/issues). Seven
came in from audited sites and were closed on 2026-08-03 by shipped checks —
eager third-party embeds, `dist:size` flagging srcset rungs, CSS
`background-image` (no srcset, no lazy loading), the two remaining font-hygiene
traps, cross-origin `preconnect`, the two Astro 7 changes that build clean and
ship wrong, and a glossary `DefinedTerm` page read as a missing Article. A second
round — three false-firing checks, the missing § browser section, the positive
`srcset` assertion (§ images), a media-kit route list that missed `/media/`
(§ content), and a threat-model claim four files made that the `browser` domain
broke (`SECURITY.md`) — closed on 2026-08-05, when the branch that had been
stranded locally finally reached `main` (PR #20). Only three of those closed
themselves: `Closes #N` fires on the number, and one commit wrote "closes the
four actionable open issues" as prose, so #13–#16 had to be closed by hand.
Worth remembering the next time a commit means to close something.
What is below is the older, quieter half
— plus, where a gap is still open as an issue, the issue is the live record and
the bullet here is only its summary.

- **Astro scoped CSS does not reach `innerHTML`-injected DOM.** A component's
  scoped styles are keyed on a `data-astro-cid-*` attribute the compiler stamps
  on markup it emits; nodes built at runtime and inserted with `innerHTML` carry
  no such attribute, so the rules simply do not apply. It fails silently and
  completely — cypruspokerbrisbane shipped unstyled search rows and an entirely
  unstyled `/search` page this way. The fix is `<style is:global>` namespaced
  under a unique class. Not checked: telling a legitimate `innerHTML` from one
  that needed styling means knowing what the injected markup is, which is a
  runtime question. Worth knowing about; not worth a false positive.
- **`src/fetch.ts` reserved (Astro 7).** Advanced routing is on by default and
  reserves the filename; a pre-existing `src/fetch.ts` that means something else
  must be renamed or `fetchFile` configured. Not checked because a *legitimate*
  v7 advanced-routing handler has exactly the same shape — the check would flag
  compliant sites, which is the one thing a check must never do.
- **Rust compiler HTML strictness (Astro 7).** Unclosed non-void tags now error
  instead of being auto-corrected. Detecting it properly means parsing every
  `.astro` template, which the no-deps tool doesn't do — the build itself is the
  honest gate here.
- ~~**hreflang alternates on multi-locale pages.**~~ Closed by `seo: hreflang`
  — the practice is § seo above. `x-default` is deliberately *not* part of it:
  `@astrojs/sitemap`'s `i18n` option does not emit one, so demanding it would be
  a finding the baseline integration cannot satisfy.
- ~~**Responsive `srcset`/`sizes`.**~~ Closed by `images: srcset:missing` — the
  practice is § images above. The thresholds came out of a measurement rather
  than taste, and the check was promoted out of advisory to house style on
  2026-09-03 once the wider sweep it was waiting for came in — **cumulative across
  both rounds**, 3 of ours plus 7 public: 10 sites, 66
  measurable candidates, 25 findings, 0 wrong (issue #21).
- ~~**Trusting a remote URL's declared width.**~~ **Declined, and measured
  rather than argued** (issue #35, 2026-09-04). `pinnedWidth()` reads `?w=`,
  `width=` and `/w_1600/`, but only behind the `/cdn-cgi/image/` gate, so a
  stock-photo URL stating its own width counted as unmeasurable. A 27-site
  corpus off the Astro showcase — mirrored, 284 pages, 6101 `<img>`, 494 remote
  non-transform candidates, 311 declaring a width — moved **0 findings** either
  way when the gate was widened.
  The reason to stop is better than the null result. On the one site in 27 that
  declares widths at all, the declared width is a *request parameter*, not the
  delivered size: `?width=600&dpr=2` measured 1200×720. So widening would read
  the wrong number on 311 of 312 images, and the number a foreign CDN puts in a
  URL means whatever that CDN says it means — a vocabulary we do not own and
  cannot enumerate. **The half that is ours we fixed instead**: `dpr` on our own
  transform syntax, and the extensionless URLs that were being dropped before
  the unmeasurable tally (both § images above). The honest report stays what it
  was — the image is named as unmeasurable rather than judged on a width no
  guard can check.
- ~~**Title and meta-description length.**~~ **Declined, 2026-09-06, and the
  evidence came from a report this tool produced.** An SEO review of a real site
  counted 64 of 106 titles and 36 of 106 descriptions as "truncated in search
  results" and ranked it the second-biggest issue. Then that site's own Search
  Console data arrived and said it was wrong: at an average position of 19.7 the
  snippet is not why nobody clicks, the ranking is. The rule had no authority
  behind it either — **Google publishes no character count anywhere**. Both the
  title-link and snippet pages say the same thing, that the text "is truncated in
  Google Search results as needed, typically to fit the device width", and the
  title page then lists seven sources Google may rewrite a title from, of which
  `<title>` is one. So the check would have been a number we invented, applied to
  a thing Google may replace, and it would have sent someone to spend a week on
  the wrong work. A count is not a finding.
- ~~**Search-performance data (Search Console, SerpAPI).**~~ **Dropped,
  2026-09-06 — the owner's call, and the right one for what this repo is.** The
  argument for it was real: rider can say how a site is built and never whether
  any of it worked, and the case above is exactly a wrong finding that live data
  would have caught. But it would have cost the invariant that makes the tool
  what it is. PSI is the *one* place this tool talks to an external API and the
  one operator secret it reads; a search domain meant two more, one of them paid
  and third-party, plus per-user credentials, an OAuth flow and a whole class of
  finding that is a fact about Google rather than a defect in the build. **A
  validator checks the artifact in front of it.** What survives the decision is
  the lesson, not the feature: a finding whose fix is a week of work needs an
  authority behind it, and "we measured it" is not the same as "Google says so".
- **Offline heading scan beyond the canonical gate (see also `headings:order`,
  which now names the component rather than the built page).** Today the offline outline
  check only inspects pages with a `<link rel="canonical">`; a page that should
  be indexable but lacks canonical is invisible to it (the live check still
  covers home + a post).
- **No-negotiation fallback probe (live).** A second `Accept: */*` image probe
  would surface a large raw-source fallback directly; today the offline
  `transform:format` check catches the same `format=webp` smell more cheaply.
- ~~**BreadcrumbList JSON-LD.**~~ Closed by `data: jsonld:breadcrumb` +
  `jsonld:breadcrumb-shape` — the practice is § data above. Presence is house
  style, malformation is universal, and the starter grew a trail to match.
- ~~**Runtime behaviour needs a headless browser.**~~ Closed by the `browser`
  domain — the practice is § browser above.
- **An impact ladder in the report — decided, not built (2026-09-04).** A first audit
  hands back a flat list, so "where do I start" is left to the reader. The order that
  matters is: can Google *reach* it (robots, sitemap, canonical, noindex) → can it
  *understand* it (title, description, one `<h1>`, `lang`, JSON-LD) → is it *good to land
  on* (CWV, images, fonts) → does it *survive being shared* (a real OG card). Nothing on a
  higher rung matters while a lower one has a finding. **The shape is settled: a summary
  block above the counts naming the highest rung that has a finding**, with the findings
  themselves still printed in domain order — regrouping the whole report would move every
  line and break anything parsing it. Presentation only, no new checks. Not built.
- **A `serp` domain was considered and declined (2026-09-04).** Keyword research decides
  *which pages should exist*, which is upstream of a validator — see the top of this file
  and `CLAUDE.md`. What would fit, if it is ever wanted, is the *outcome* half rather than
  the input half: modelled on `lighthouse` (`--url` only, API-key gated, skipping cleanly
  without one) and **advisory by construction**, since rankings move for reasons that are
  not the code. It would verify what the offline checks can only assert — whether the page
  is indexed at all, whether the rich result our JSON-LD claims eligibility for actually
  renders, how the title truncates in a real SERP. Recorded so it is not re-proposed as
  keyword research.
- **Zaraz consent banner actually renders + GA waits for consent.** The
  `analytics` live check confirms the Zaraz loader is present, but the consent
  modal and whether tags hold until consent are decided by client JS at runtime
  (`zarazConsentAPIReady`, the `cf_consent` cookie) — invisible to a `fetch` of
  the HTML, and never to be faked from static HTML. It *used* to be listed here
  as impossible: the tool ran no browser. The `browser` domain does, so what
  keeps this open is that nobody has written the check, not that it can't be
  written — and whoever does should note that `analytics` is advisory by
  construction (`tools/lib/policy.mjs`), so a consent finding is a `💡` however
  certain the browser is about it.
