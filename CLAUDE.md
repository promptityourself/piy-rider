# Prompt It Yourself Rider (`piy-rider`) — dev notes for this repo

This repo is **piy-rider**: a Claude Code plugin whose two mode commands (`/piy-rider:audit`, `/piy-rider:create`) check an Astro site against baseline best practices, or start one that already complies — plus `/piy-rider:bug`, which files a rider bug when a check gets it wrong. It is *not* a framework — nothing is installed into an audited site, nothing auto-loads, and their `CLAUDE.md` is never touched. You run it when you want a compliance check; it prints findings, and `--fix` applies the ones it can prove.


## What it is

- **Two modes, one copy of each.** `skills/rider/SKILL.md` is a router *only*: it picks **create** or **audit** and sends the reader to `references/CREATE.md` or `references/AUDIT.md`. The commands in `commands/` inline those same two files with `@${CLAUDE_PLUGIN_ROOT}/…`, so a typed command and an inferred mode run identical instructions and there is no second copy to drift. The router exists for the inferred path alone — never duplicate a mode's steps into it. **`commands/bug.md` is deliberately not part of that arrangement**: it is self-contained, because a reference file exists to be shared with the router and the router routes *modes*. It has one consumer, so it gets one file, not two.
- **Two tools, and only one of them audits.** `tools/brief.mjs` reads a design
  brief someone pasted into create mode — the versions to build, the exact token
  and font values each gets, and the content the brief names, fetched and checked
  before a page can see it. It writes nothing into a site. It exists because the
  alternative is an agent parsing a stranger's JSON by eye and pasting the result
  into a config file: `lib/brief.mjs` re-derives every value that reaches a
  directory name, a stylesheet or `astro.config.mjs` from a strict pattern, and a
  brief is recognised by SHAPE — a `variations[]` naming colour and type — never
  by the `generator` string that names its producer.
- **The audit tool:** `tools/audit.mjs` — the entry. Detects an Astro project, runs the offline domain checks, and (with `--url`) the live ones. `tools/verify-example.mjs` is the harness that builds an example, serves it the way its adapter demands, and points the audit at it — never a static server on a split `dist/`, which serves a directory listing and passes against nothing. Reports `✅ / 🔧 / 🛑 / 💡 / ⏭` and exits non-zero on findings.
- **Seven offline domains + three `--url` domains**, one module each under `tools/checks/`:
  `modules`, `seo`, `images`, `perf`, `data`, `analytics`, `content` offline; `live`,
  `lighthouse`, `browser` only with `--url`.

  **What each one checks is NOT written here — `node tools/audit.mjs --rules --json` is
  the authoritative list**, 173 rules with each one's id, section, severity, mode and why.
  A prose copy of it used to sit in this bullet and drifted: four releases after
  `images: srcset:missing` was promoted, this file still gave it the severity it had
  before — in the document every session in this repo loads. `README.md` and `tools/README.md`
  each carry a reader-facing summary and both already say the catalogue outranks them;
  this file, which is read by the thing that can just run the command, points at it
  instead. `BEST-PRACTICES.md` is the *why* behind each rule and `tools/test.mjs` now
  asserts that any severity a doc states matches the catalogue.

  Three domain-level facts that are not in the catalogue, because they are about the
  domain rather than a rule: `analytics` is advisory by construction (no 🔧/🛑 branch in
  either mode); `browser` is **the tool's one exception to "never executes the audited
  project's code"** — it imports a driver from the project's `node_modules` when it has
  none of its own, auditor-tree-first, disclosed in the output as `browser:
  playwright:source` and stated in `SECURITY.md` rather than denied (issue #19), and
  don't add a second exception; `lighthouse` needs a free PSI key in
  `$PAGESPEED_API_KEY` and skips cleanly without one.
- **Shared:** `tools/lib/project.mjs` (detect + load), `tools/lib/reporter.mjs` (outcomes + exit code; `💡 suggest` is advisory and never fails the run), `tools/lib/policy.mjs` (universal vs house style), `tools/lib/rules.mjs` (the `--rules` catalogue), `tools/lib/html.mjs` (attrs + the one spec-shaped `srcsetUrls` — never `split(',')`, a Cloudflare transform path is full of commas — plus `blankScripts`, and **the three traps of reading markup with a regex, all three of which cost us something real**: (1) the attribute scan must be UNAMBIGUOUS — `(?:[^>"']|"[^"]*"|'[^']*')*`, never `(?:"[^"]*"|'[^']*'|[^>])*`, whose `[^>]` also matches a quote and so partitions a long run exponentially; a real page shipping `<a.addedNodes` in minified React hung one audit for 15+ minutes, fixed in 21 places, now 0.1s. (2) script and style bodies are NOT markup — `blankScripts` blanks them offset-preserving before any tag scan, which is both what killed that hang at the root and why `links:internal` no longer resolves URLs out of JavaScript. (3) a LOOKAHEAD cannot assert an attribute is non-empty: every spelling of it is satisfiable by a quote in a LATER tag, so `<meta name="description" content="">` read as filled whenever anything quoted followed it — read the tag and use `attrValue`, never pattern-match around it), `tools/lib/config-string.mjs` (the one reader for a string value in config TEXT — the quoted-value regex lived in four places and all four excluded *every* quote from the value, so `tagline: "Australia's …"` read as an absent key; never hand-roll a fifth), `tools/lib/css-flow.mjs` (which elements CSS takes out of flow, so the CLS checks don't fire on absolutely-positioned fill images), `tools/lib/image-size.mjs` (intrinsic dimensions from PNG/JPEG/WebP/AVIF bytes — an unreadable format is a missed finding, never a wrong one, which is why AVIF stopped being acceptable to skip). PSI is the only place the tool talks to an external API, and the only operator secret it reads.

## Working rules

- **Assumes a baseline.** The checks encode the baseline Astro stack (Astro 7+, the integrations, Cloudflare delivery / image transforms, immutable hashed-asset caching). The tool validates compliance against it — it does not set anything up or migrate. The version floor is a deliberate, dated decision — see `BEST-PRACTICES.md` § modules before moving it, and re-verify against npm rather than assuming.
- **Command-driven, never passive.** No contract `@import`, no auto-loading, nothing written into an audited project unless the user asked with `--fix`. If you find yourself wanting an always-on hook or a contract, stop — that's the thing this repo was deliberately stripped of.
- **Surface by default; fix only what was measured.** A run writes nothing. `--fix` is the user asking, and it applies only findings carrying a **remedy** — the machine-applicable half of a finding (`tools/lib/remedy.mjs`). **The bar for attaching one: the fix must be fully determined by what the check already measured.** `perf: cls:img-dimensions` qualifies — width and height come out of the image's own bytes, so there is one right answer and the tool already has it. `images: alt` never will, because no analysis tells you what the text should say, and a remedy that guesses is worse than none: it looks like the tool knew. Three kinds only — `copy` (a starter file, create-only), `json` (one key, indent preserved, arrays merge), `edit` (an exact string that must occur exactly once). Then `tools/lib/fixer.mjs` **re-runs the audit** and requires that every claimed fix is gone and nothing required appeared; if anything did, the whole set is reverted byte for byte. The verification is the feature — the writing is the easy part.
- **Cloudflare first; never offer a third party unasked.** The baseline favours Cloudflare services and the platform's own primitives — a typed form endpoint over a form vendor, self-hosted fonts over a CDN, Web Analytics over a tag, a build-time card over a card service. The checks *recognise* third-party engines and hosts because a validator must; they never *recommend* one, and neither does create mode or any suggestion text, unless the user names it. `BEST-PRACTICES.md` § *Own it before you buy it* is the why.
- **This repo is a validator and nothing upstream of one.** It checks sites and scaffolds a compliant one. Which pages a site should have is an input that arrives as an issue or a request; where that input was worked out is not this repo's concern, and nothing here should name or depend on it.
- **Practice ⇒ check (the `BEST-PRACTICES.md` contract).** `BEST-PRACTICES.md` is the *why* behind every check and a living practice↔check registry. Every best practice there has an enforcing check in `tools/checks/*`; a practice with no check is a tracked *gap*, not a practice yet. Adding one = understand the integration (context7) → write the why in `BEST-PRACTICES.md` → bake the check → verify on the fixture (stays `0 🔧`) + a real site → ship. Keep `BEST-PRACTICES.md` § Gaps current.

  **Half of this is enforced, and the half is deliberate.** Most practice bullets
  name their check with a `→ \`domain: rule\`` arrow, and `tools/test.mjs` asserts
  every id named that way exists in the catalogue — so a renamed or deleted check
  breaks the build instead of quietly orphaning a practice. The rest stays prose
  on purpose: the bullets without an arrow are explanatory notes ("comments are
  blanked before matching", "a finding that could not have gone the other way is
  not a finding"), not practices, and requiring an id on every rule would turn a
  document whose job is the *why* into an index. `--rules --json` is already the
  index. **The counts that used to sit here are gone** — they were four numbers
  no test pinned, and all four had drifted from the file they described.
- **A rule that encodes Google's behaviour names the page and the date it was
  read.** `docs/sources.json` is the record: nineteen Search Central pages, each
  with the `Last updated` date printed on it, the date we read it, and the rule
  ids resting on it. `node scripts/google-sources.mjs` re-reads them and exits
  non-zero when one has moved; a weekly workflow opens one issue naming the page
  and its rules. `--accept` records the new dates once a human has re-read the
  page. **Never bump a date without reading the page**, and note that Google
  serves a dateless variant of these pages — the script sends no user-agent and
  retries for that reason.

  **It is not an inventory of universal rules, and absence from it means
  nothing.** 73 of the 113 universal rules are uncited and most of them should
  be: the `modules` domain answers to Astro's own docs, `perf` and image
  delivery to the web platform, the `og:*` tags to the Open Graph protocol, the
  JSON-LD shapes to schema.org, the scores to Lighthouse, and a dozen rows are
  the tool reporting on itself. A build that will not start is a defect
  whatever Google publishes. The first version of this bullet said a rule with
  no source is house style; that was false when written, and it was written in
  the file every session here loads.
- **Verify Astro/Cloudflare specifics via `context7`** before writing about them or generating config/code (hard rule).
- **Provenance comments name a date, never a BORROWED host.** Our own sites are fair to
  name and ~10 comments in `tools/` do (`tasmanvisa-web`, `cypruspokerbrisbane`,
  `matevisky-web`) — that is not a violation of this rule, it is the case the rule does not
  cover. What the rule is about: two comments used to name the site
  that was measured on 2026-08-03 (`tools/checks/live.mjs`, the `/glossary/agent/` case
  behind issue #11; `tools/test.mjs`, the trimmed PSI fixture). The names are gone — that
  host was on loan from the show and the credit is the show's. What stays is what makes
  the comment worth anything: a real site, that date, what it actually answered. Never
  relabel a captured response with a host that did not serve it; write "a real site"
  instead, which is true whatever the branding does next.
- **The `lighthouse` domain can only be exercised against a public URL** — PSI fetches from Google's side, so `127.0.0.1` always answers 400 and CI has no key. `node scripts/test-site.mjs deploy` publishes the starter to `piy-rider-test1.promptityourself.com` and `… audit --strict` audits it live; redeploy after changing the starter. Ours for testing only — the plugin never asks a user for one. `docs/DEVELOPING.md` has the why.
- **Two example sites, upgraded together.** `examples/_fixture-i18n/` is the multi-locale exerciser (i18n, search, preview routes); `examples/starter/` is the single-locale reference and what create mode copies. Both must be `0 🔧 / 0 🛑` in default **and** `--strict` — and now also LIVE: CI runs the matrix offline in both modes and then `node ../../tools/verify-example.mjs --strict` inside each, so the `live`/`lighthouse`/`browser` domains are exercised against them too. **Raising the baseline means upgrading both in the same commit** — a floor moved in one makes the other's clean run a lie. Testing/deploy discipline lives in `docs/DEVELOPING.md`.
- **A brief answers create mode's questions; it does not get to answer them
  loosely.** Palette and type are an *edit list* — every value names a custom
  property the starter already declares, so applying it is mechanical. Ornament
  family and layout archetype are *guidance*: they describe a page structure this
  starter does not have, and the plan keeps the two apart so a version is never
  claimed to reproduce a reference it merely resembles. Content that arrives with
  a brief is public-domain/CC0 material under a licence that requires a visible
  credit, which is `src/data/sources.json` + `components/Sources.astro` in the
  starter and `content: sources:credited` in the audit. **That credit is honest
  about being incomplete**: the content ships work titles and no author or
  licence, so the block says so rather than inferring one — see `BEST-PRACTICES.md`
  § content. The fonts recipe in `references/CREATE.md` lists two weights per
  family rather than a range, which is not what Astro's docs suggest and is what
  measured clean: a range asked of a *static* family builds one face per published
  weight and trips `perf: font:faces` (measured 2026-09-07, Playfair Display +
  Spectral, 5 faces → 🔧).
- **The starter is the baseline's existence proof, not a second copy of it.** The checks define compliant; `examples/starter/` is a site that is. `references/CREATE.md` describes only the *interaction* and is forbidden from restating the rules — it points at `--rules --json` for what, and `BEST-PRACTICES.md` for why. A third prose copy of the baseline is how all three drift.
- **Create mode copies, never composes.** It copies `${CLAUDE_PLUGIN_ROOT}/examples/starter` verbatim and edits four files. Writing files from memory is exactly how a scaffold stops matching the reference the audit keeps clean. The starter ships *inside* the plugin, so it is always the version create mode was written against — that used to be a symlink that could go missing.

## Install

It is a plugin, and this repo is its marketplace:

```
/plugin marketplace add promptityourself/piy-rider
/plugin install piy-rider@piy-rider
```

**The plugin/marketplace format is a settled decision (2026-09-03), and it is load-bearing
rather than packaging taste.** It is the only mechanism that puts the instructions into a
session inside *someone else's* repo without writing anything into that repo — which is the
constraint the whole design rests on (see *Command-driven, never passive* above). Drop it
and you either lose the instructions or reintroduce per-project wiring; and the `«…»`
untrusted-output boundary in particular is enforced in the tool but *obeyed* only by
instruction, so a bare CLI hands an agent fenced third-party HTML with nothing telling it
that is data. The release ceremony is the real cost, and the fix for that is fewer, fuller
releases — not a different format. The standalone CLI already exists and CI uses it; the
two are not alternatives.

`.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`; `commands/` and `skills/` are found by convention. **Dogfood through the marketplace, not `--plugin-dir`** — `--plugin-dir` loads the working tree and so cannot surface an install or packaging bug; push, then `claude plugin marketplace update piy-rider && claude plugin update piy-rider@piy-rider`, then restart (`docs/DEVELOPING.md` § Releasing). `--plugin-dir` is for a fast inner loop only. **`${CLAUDE_PLUGIN_ROOT}` is expanded in the markdown before the model sees it and is NOT set in the shell** — verified, and the reason a path can look right and still fail at the first Bash call. Working on the plugin means `claude --plugin-dir ~/projects/piy-rider`; an installed copy is version-pinned in the plugin cache and a `git pull` here does not touch it.

