# Prompt It Yourself Rider

<sub>`piy-rider`</sub>

An on-demand best-practices auditor for **Astro** sites — and a compliant site to start from. A Claude Code plugin — two slash commands (`/piy-rider:audit`, `/piy-rider:create`) over one zero-dependency script, ten domains (seven offline + three live), plus `/piy-rider:bug` for when it gets one wrong. No framework, no contract, nothing installed into the sites it audits — it reports, you decide.

```
💡 modules: astro:version — ^6.3.7 (baseline is ^7+) [baseline]
🔧 perf: font:bytes — 532 KB of webfonts in 2 file(s) — over the 500 KB budget
🔧 perf: preconnect (index.html) — 15 images load from https://media.example.com with no
     <link rel="preconnect"> on 6 page(s) — DNS + TLS only start when the parser reaches the first one

58 ✅   4 🔧   0 🛑   18 💡   10 ⏭
audit complete — 4 findings to address (exit 1).
```

## Quickstart

No install, no dependencies, no API key. From the root of any Astro project:

```bash
git clone --depth 1 https://github.com/promptityourself/piy-rider.git /tmp/piy-rider
npm run build          # optional, but the image + perf checks read dist/
node /tmp/piy-rider/tools/audit.mjs
```

That's the whole thing. You get findings like:

```
🔧 modules: mdx:reachable (src/content.config.ts) — @astrojs/mdx is installed and no loader pattern
     admits .mdx — an .mdx file produces no page and no error
🔧 perf: font:format (dist/client/fonts/JetBrainsMono-Bold.ttf) — 2 font file(s) served as ttf/otf/eot
     fix: convert to woff2 — universally supported for years and roughly half the bytes

58 ✅   4 🔧   0 🛑   18 💡   10 ⏭
14 of the 💡 are [baseline] — this project's house style (Cloudflare delivery, llms.txt, RSS …),
not universal practice. Re-run with --strict to treat them as required.
audit complete — 4 findings to address (exit 1).
```

*(A real run, captured 2026-09-03, against an off-baseline Astro 6 site — not a mock-up.
The `⏭` are checks that could not run: no `--url`, no PSI key, no playwright.)*

**Want measured PageSpeed scores too?** One free API key ([2 minutes, no billing](https://developers.google.com/speed/docs/insights/v5/get-started)) against a publicly reachable URL:

```bash
export PAGESPEED_API_KEY=…
node /tmp/piy-rider/tools/audit.mjs -s lighthouse --url https://example.com
```

**Want to test the running site in a real browser?** Install Playwright in *your* project and the `browser` domain switches itself on:

```bash
npm i -D playwright && npx playwright install chromium
node /tmp/piy-rider/tools/audit.mjs -s browser --url https://example.com
```

That catches what no static check can: scripts that throw, assets that 404 only when requested, real measured layout shift, and images served at 4× the size they're displayed.

See [`.env.example`](.env.example) for every optional key, and [`examples/ci/audit.yml`](examples/ci/audit.yml) for a copy-paste CI job.

## Required vs suggested

This tool ships an **opinionated baseline** — Cloudflare delivery, Cloudflare Web Analytics, RSS + `llms.txt` endpoints, a particular file layout. Those are defensible choices, but your site isn't *broken* for making different ones.

So by default only **universal practice** is required (`🔧`): missing canonical/OG meta, images without dimensions, no structured data, oversized assets, unschema'd content collections, Astro 7 config that will break your build. Everything that's just house style reports as `💡 … [baseline]` and doesn't fail the run.

```bash
node audit.mjs             # universal practice only — 4 🔧, 18 💡 on the site above
node audit.mjs --strict    # require the full baseline too — 18 🔧
node audit.mjs --report audit.html   # …and write the run as a page you can send someone
```

Use `--strict` when you've adopted the baseline deliberately and want it enforced. What counts as which — and why — is one readable table in [`tools/lib/policy.mjs`](tools/lib/policy.mjs); disagree with a call and it's a one-line edit.

A few checks report a *fact* rather than a verdict and are `[advisory]` in **both** modes — `--strict` doesn't promote them, because they have no failing branch at all. `analytics: provider` is the one that matters: it tells you what's delivering analytics, including when the answer is nothing, and never fails a run. Whether you measure your traffic is your call.

`node audit.mjs --rules --json` is the authoritative list of every rule and which of the three it is. Prefer it over any summary written down elsewhere, including this one. Each entry also carries `mode` — `offline` or `url` — because a large minority of rules never fire without `--url`, and a catalogue that does not say so answers "what do you check?" with substantially more than the run you are about to do can reach. The split is in `--rules --json`; it is not restated here, because a number written down twice drifts.

## What it checks

| Domain | What it looks for |
|---|---|
| **modules** | Baseline stack present + wired: Astro 7+, Node ≥ 22.12, the expected integrations, `output: 'static'`, strict TS (≤ 6.x, the `@astrojs/check` peer ceiling), an adapter iff any route renders on demand (`output: 'server'` **or** a single `prerender = false` page) and an explicit `imageService` so the Cloudflare adapter can't opt you into paid image billing; search is optional, but two search engines at once is a finding. Plus Astro 7 migration residue — stabilized `experimental` flags, unified()-only markdown options without `@astrojs/markdown-remark`, `@astrojs/db`, removed `astro:transitions` internals, a `tsconfig` `exclude` that stopped covering `dist`, and `compressHTML` left unset (v7's new `'jsx'` default strips the whitespace between prose and an inline element — it builds clean and ships wrong text). Also: a custom 404 the host will actually serve — on Workers Static Assets an unmatched URL falls to the Worker if there is one and otherwise to a bare platform 404, so a branded 404 can build, ship and never render. |
| **seo** | A canonical SEO component emitting `<title>`, meta description, canonical URL + OG meta on every page the sitemap declares; no `keywords` anti-pattern; the sitemap read against Google's own rules — absolute URLs, the 50,000-URL / 50 MB caps, a `<lastmod>` that parses, and no `changefreq`/`priority`, which Google ignores — then cross-checked against the pages it lists for `noindex`, a robots.txt `Disallow`, or a canonical pointing somewhere else; hreflang alternates once the config names two locales; one `<h1>` per content page (no skipped heading levels — advisory, and it names the component that emitted the heading rather than the built page whenever exactly one source matches). Then the things a page can only get wrong once it exists alongside others: `<html lang>` (WCAG 3.1.1, and what hreflang assumes), exactly one absolute canonical and one document `<title>`, internal links that actually resolve, published pages nothing links to, a title or description used twice, indexable pages the sitemap left out, and a `Disallow: /` that withholds the whole site. Then the surface Google publishes rules for and most tools skip: a viewport meta, a favicon in one of the formats Google Search actually reads (SVG is not one of them, and `/favicon.ico` counts), hreflang alternates that are absolute, self-listing and reciprocal, robots-meta directives Google implements — including the trap of a `noindex` on a URL `robots.txt` forbids, which Googlebot can never fetch to read — and, advisory, link text that names its destination. Every one of those traces to a Search Central page and a date in `docs/sources.json`. |
| **images** | Content images routed through an image transform (resized/reformatted, not full-size) and not oversized in `src/assets/` or the built `dist/` — a responsive image is judged as a **ladder** on its smallest rung, the one a phone actually downloads, not on the top rung Astro emits unconditionally. A CSS `background-image` pinned to a fixed width is its own finding, since it can use neither srcset nor lazy loading. On built HTML, flags Cloudflare transform params (`format=auto` instead of an explicit format; explicit `quality=`) and content `<img>` missing `alt`. Live, it also verifies the transform **actually ran** (Cloudflare Image Transformations are a per-zone toggle — a `/cdn-cgi/image/` URL on a zone where they are off serves the original, or nothing, and looks identical in the HTML) and that every content image resolves at all. |
| **perf** | `/_astro/*` marked immutable in `public/_headers`; content `<img>` carry width/height (no layout shift); render-blocking CSS on the heaviest page and total webfont weight stay in budget, in woff2. Heavy third-party embeds (Maps, YouTube, Vimeo…) sit behind a facade rather than loading with the page — `loading="lazy"` doesn't count, it won't defer a frame high on the page. Cross-origin image hosts carry a `preconnect` **with `crossorigin`** (without it the connection isn't reusable — it looks fixed and isn't), and a head `preload` matches its `<img>` byte for byte or the image downloads twice. Every declared font family leads a `font-family` stack and sets `styles`, since the API default `['normal','italic']` builds italic faces nothing may render. |
| **content** | The pages a site is repeatedly asked for: a media kit (logo, paste-ready boilerplate, a contact route) and a design/styleguide page rendering the real tokens. Both house style, so `💡` unless `--strict`. Plus a prose lint for a straight quote sharing a line with a directional one — the input Sätteri and remark resolve differently — advisory in **every** mode, because correct prose can do it too. |
| **data** | The machine-readable surface other tools consume: JSON-LD (an Article-family type + WebSite), `/llms.txt` built from the content store, RSS, a search-index endpoint when the site's search engine reads one the site emits (Pagefind builds its own from `dist/`, Algolia/Meilisearch/Typesense host it — those skip), a Zod-validated content schema. Endpoints match by pattern, so single- and per-locale naming both pass. |
| **analytics** | What delivers analytics here — **advisory in every mode**, because whether you measure traffic is your call, not a defect. The baseline default is Cloudflare Web Analytics: free, cookieless, no consent banner. Zaraz is fully supported for when you need a tag manager, and its loader is edge-injected so `--url` is what confirms it. The one *finding* is a hardcoded GA/GTM snippet, which fires before consent. |
| **live** | With `--url`: real Cache-Control headers, served image bytes (measured with a browser-realistic `Accept`) + transform-param flags, rendered SEO + JSON-LD, `/llms.txt` — against a running or deployed site. |
| **browser** | With `--url`: what only a real browser sees — uncaught JS exceptions, requests that failed or 404'd, **measured** CLS, images downloaded far larger than they're displayed, heavy third-party origins, and whether every route the wide nav offers is still reachable at phone width. Needs `playwright` installed **in the site you're auditing**; skips cleanly without it. |
| **lighthouse** | With `--url`: real **measured** scores via the PageSpeed Insights API — Performance/SEO/Accessibility/Best-Practices + Core Web Vitals (LCP/TBT/CLS) — plus what makes a stuck score readable rather than dismissable as lab noise: the LCP element, the heaviest third-party payloads, and simulated vs *observed* FCP/LCP. Needs a free PSI key (below); skips gracefully without one. |

Before any of those run, the audit says whether `dist/` is older than the source it was
built from — `project: dist:stale`. It is not an `-s`-selectable domain, it is the gate in
front of them: every check that reads `dist/` is judging a build, and a build the source
has moved past is a different site. One audit reported clean on a project whose build was
outright broken, because it read the `dist/` the last good build left behind.

The static domains answer *"is it wired right?"*; `lighthouse` answers *"what's the real score?"* — complementary layers.

## A report you can hand to someone

Terminal output is for whoever ran the audit. `--report <path>` also writes the same run as a
single self-contained HTML page — no build step, no assets, no network — designed to be opened
by the person who owns the site rather than the person who ran the tool.

```bash
node audit.mjs --strict --report audit.html
```

Findings are grouped by what they demand of you, blocking first, with the passing checks kept
(collapsed) so a regression is visible next time. Skipped checks are stated rather than folded
into a clean bill — a check that could not run is not a check that passed. It carries the same
`«…»` fencing the terminal uses, and every value is escaped: a `--url` run renders a third
party's `<title>` and console output, so the audited site does not get to write markup into a
page its owner opens.

It writes exactly where you point it and nowhere else. A run without `--report` still writes
nothing at all.

## Fixing, without hand-writing the fix

A plain run writes nothing. `--fix` is you asking it to, and it applies only findings that
carry a **remedy** — the machine-applicable half of a finding, attached by the check that
found it.

```
node audit.mjs --dry-run          # the exact changes, written nowhere
node audit.mjs --fix              # apply them, then re-audit to prove they worked
node audit.mjs --strict --fix     # …including the baseline findings
```

**A remedy is attached only when the fix is fully determined by what the check already
measured.** `perf: cls:img-dimensions` qualifies: the width and height come out of the
image's own bytes, so there is exactly one right answer and the tool already has it.
`images: alt` never will — nothing tells you what the alt text should say, and a remedy
that guesses is worse than none, because it looks like the tool knew. Findings without one
still print their prose fix; that is not a degraded outcome, it is an honest one.

What makes it deterministic is not the writing but the loop after it: the audit **runs
again**, and every finding claimed as fixed has to be gone with nothing required appearing
that was not there before. If anything did, the entire set is reverted byte for byte — a
fixer that can leave a project worse than it found it is not worth having.


**This tool assumes a specific baseline** (Astro 7+, static output, Cloudflare delivery, Cloudflare Web Analytics) and validates compliance against it. It does not set anything up or migrate. If your stack differs, the checks are small and readable — fork and adjust.

**The *why* behind every check lives in [`BEST-PRACTICES.md`](BEST-PRACTICES.md)** — a living practice↔check registry. The governing rule: every practice there has an enforcing check, and a practice with no check is a tracked *gap*, not a practice.

## Install

In [Claude Code](https://claude.com/claude-code):

```
/plugin marketplace add promptityourself/piy-rider
/plugin install piy-rider@piy-rider
```

Update later with `/plugin update piy-rider`. It installs nothing into any project and never touches a project's `CLAUDE.md`.

Requires **Node 22+**. No `npm install` — the tool uses Node built-ins only, and the plugin carries them with it.

## Use

From inside any Astro project, in [Claude Code](https://claude.com/claude-code):

```
/piy-rider:audit                        # offline: source + dist checks
/piy-rider:audit https://example.com    # also check the live/served site
/piy-rider:create                       # scaffold a new site in an empty directory
/piy-rider:bug                          # rider got it wrong — file it
```

`/piy-rider:create` scaffolds. It asks three
questions — site name and domain, contact email, a one-line tagline — then copies
[`examples/starter/`](examples/starter), edits them in, builds, and runs
the audit on what it just made.

**Or paste it a brief instead of answering.** If you picked a look somewhere else
and arrived with a spec — several versions to compare, palettes, type, and often
the words already written and sourced — create mode reads that rather than asking
what colour you want. It builds one site per version, applies each palette and
type pair exactly, gives each version different content so they are worth
comparing, and credits any sourced material on every page it builds. That last step is the point: the starter is kept
at `0 🔧 / 0 🛑` under `--strict` by this repo's own CI, so a scaffolded site is
compliant by construction rather than by intention.

You get a working blog, a contact form that sends real email through Cloudflare
Email Service (free to a verified address, no API key to store), cookieless
analytics, a media kit, a design reference page, RSS, `/llms.txt` and a sitemap
with real `<lastmod>`. Three dashboard steps are left for you, and it says which.

Or call the script directly — it's a plain CLI, Claude Code is optional:

```bash
node /tmp/piy-rider/tools/audit.mjs --help
node /tmp/piy-rider/tools/audit.mjs                     # everything offline
node /tmp/piy-rider/tools/audit.mjs -s seo -s images    # scope to domains
node /tmp/piy-rider/tools/audit.mjs --url https://example.com  # add live + lighthouse
node /tmp/piy-rider/tools/audit.mjs --json              # machine-readable
```

`--url` works from **any directory** — the offline domains need an Astro project in the cwd, but a live/lighthouse run only needs the URL.

Outcomes: `✅` pass · `🔧` fixable (required) · `🛑` needs a decision · `💡` optional suggestion · `⏭` skipped. Exit `0` if clean (suggestions don't count), `1` if any required findings, `2` on tooling error — so it drops into CI as-is.

## Optional: `scripts/og.config.mjs`

A few checks read brand details from an optional file at `scripts/og.config.mjs` in the audited project. **You don't need it** — without it, those checks simply don't run. If you have one, this is the shape the tool looks for:

```js
export const config = {
  brand: {
    siteName: 'Example',                 // required by seo: brand.siteName
    siteUrl:  'https://example.com',     // required by seo: brand.siteUrl
    tagline:  'What the site is about',  // required by seo: brand.tagline
    mediaDomain: 'media.example.com',    // enables modules: remotePatterns
    authorName: 'Example',               // optional, richer social cards
    authorUrl: 'https://example.com',
    twitterSite: '@example',
    twitterCreator: '@example',
  },
};
```

Creating this file **adds** required checks (`brand.siteName`, `brand.siteUrl`, `brand.tagline`), so add it only if you want them enforced. The file is read as text and never executed — see [`SECURITY.md`](SECURITY.md).

## Optional API keys

Both live-API domains skip gracefully when their key is absent; everything else still runs.

**PageSpeed Insights** (`lighthouse`) — set `$PAGESPEED_API_KEY` to a [free PSI key](https://developers.google.com/speed/docs/insights/v5/get-started). Note that a single Lighthouse run is **noisy** (lab scores swing run-to-run) and the API needs a **publicly reachable** URL.

The tool only ever *reads* through this API. It never provisions, never writes.

## Layout

```
.claude-plugin/
  plugin.json                the plugin manifest
  marketplace.json           the catalogue that serves it (this repo, one entry)
commands/
  audit.md, create.md        the two mode commands — thin, and each inlines the
                             mode's own instructions rather than restating them
  bug.md                     file a rider bug from what actually happened in the
                             session — self-contained, nothing else loads it
skills/rider/
  SKILL.md                   the mode router, for when an agent invokes rider
                             itself and has to infer create vs audit
  references/AUDIT.md        how to run and report an audit — loaded by the skill
                             and by /piy-rider:audit, one file either way
  references/CREATE.md       the steps for create mode, same arrangement
tools/
  audit.mjs                  entry: detect project, run domains, report
  brief.mjs                  read a pasted design brief into a plan create mode can
                             work: versions, exact token/font values, fetched content
  test.mjs                   the offline half of the gate: fixture + known-bad projects
  verify-example.mjs         the live half: build, serve, audit with --url, run from inside an example
  checks/{modules,seo,images,perf,data,analytics,content,live,lighthouse,browser}.mjs
  lib/{project,reporter,policy,rules,cf-image,html,css-flow,dist,headers,jsonld,
       image-size,src-scan,untrusted,analytics-signals,search-engines,embed-hosts,
       fonts-config,config-string,remedy,fixer,report-html,text,walk,brief}.mjs
docs/sources.json            every Google page a rule rests on, its printed date, and
                             the rules resting on it
scripts/google-sources.mjs   re-reads them; a weekly workflow files an issue when one moved
examples/starter/            the reference site: single-locale, compliant under
                             --strict, and what create mode copies
examples/_fixture-i18n/      a compliant multi-locale Astro site — the harder
                             test target (i18n, search, preview routes)
examples/ci/audit.yml        copy-paste GitHub Actions job for your own site
evals/                       plugin-eval cases for the instructions, not the tool
scripts/mirror-corpus.mjs    mirror live sites into throwaway dist/ trees, to audit against
scripts/test-site.mjs        deploys the starter to the live test site (lighthouse
                             needs a public URL — see docs/DEVELOPING.md)
BEST-PRACTICES.md            the why behind every check + the practice/check registry
docs/DEVELOPING.md           testing discipline, design decisions, how a release ships
CONTRIBUTING.md              the pre-ship checklist, short form
SECURITY.md                  what the tool reads, what it never executes, how to report
.github/ISSUE_TEMPLATE/      bug.yml — the web form, for reporting without the plugin
                             config.yml — points the rest at the plugin's own /piy-rider:bug
                             (/piy-rider:bug posts a free-form issue instead)
.env.example                 the optional API keys
.mcp.json                    declares context7 (the doc-lookup rule needs it);
                             the key comes from $CONTEXT7_API_KEY, never the file
.claude/settings.json        recommends the frontend-design and plugin-dev plugins
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: `node tools/test.mjs` is the offline half of the gate and `node ../../tools/verify-example.mjs` inside either example is the live half — CI runs both, a new check needs both test halves (stays quiet on the compliant example sites **and** fires on a known-bad project), it must be classified in [`tools/lib/policy.mjs`](tools/lib/policy.mjs) or it will start failing strangers' builds, and anything that moves the baseline updates **both** `examples/` sites in the same commit.

Security issues: please use [private reporting](SECURITY.md), not a public issue.

## Safety

The tool is meant to be pointed at projects you don't control, so it **never executes the audited project's source** — config is read as text and parsed, never `import()`ed. A plain run writes nothing to the project; `--fix` is the one path that does, and only for findings whose fix the check itself computed (see § *Fixing, without hand-writing the fix*). No network requests unless you pass `--url`.

One documented exception: with `--url`, the optional `browser` domain imports `playwright`, and the copy it finds is usually the audited project's — so a hostile repo can reach the auditor process that way. Leave `--url` off (or use `-s live -s lighthouse`) when auditing something you actively distrust. Details in [`SECURITY.md`](SECURITY.md).

## Licence

[MIT](LICENSE) — © 2026 Mergodon Limited. **Prompt It Yourself** is a brand of Mergodon Limited. Use it, fork it, sell it; just keep the notice.

The auditor itself has **zero dependencies**, so nothing third-party is redistributed here. The example fixture installs its own dependencies from npm under their respective licences (predominantly MIT, with Apache-2.0, ISC, MPL-2.0 and LGPL-3.0 transitives) — those are fetched at install time, not vendored into this repo.

Not affiliated with or endorsed by Google, Cloudflare, or the Astro project. Product names are used only to identify what is being checked.
