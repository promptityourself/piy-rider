# Developing

Testing discipline and the load-bearing decisions. Architecture and the domain list
live in `CLAUDE.md`; the *why* behind each individual check lives in
`BEST-PRACTICES.md` (the practice↔check registry).

## Key decisions

- **Verify, never provision — and never execute the project's source.** The tool
  reports; a plain run never writes to an audited project, and only `--fix` ever does.
  Config is read as text and parsed,
  never `import()`ed: auditing a repo must never be equivalent to running it. The single
  exception is the optional `browser` domain, which imports `playwright` from the
  project's `node_modules` when the auditor has no copy of its own — `--url` only,
  auditor-tree-first, and announced in the output as `browser: playwright:source`.
  It is documented in `SECURITY.md` rather than papered over (issue #19); a second
  exception should not be added.
- **Command-driven, never passive.** No contract `@import`, no auto-loading, nothing
  written into audited projects. If you find yourself wanting an always-on hook, stop —
  that's deliberately not what this is.
- **The version baseline is a floor for the baseline stack, not for every Astro site.**
  `--strict` treats being behind the floor as a required finding, because a site that
  opted into this baseline should track it. In the default mode `modules:astro:version`
  is house style (`tools/lib/policy.mjs`) — a stranger's site being a major behind is
  worth telling them, not worth failing their build over. The floor and its date live
  in `BEST-PRACTICES.md` § modules.
- **Version claims get re-verified, never recalled.** Every number in the baseline was
  read live (`npm view <pkg> version peerDependencies engines`) before being written
  down — that's how the TypeScript trap surfaced: `typescript@latest` is 7.x, but
  `@astrojs/check` peers on `^5 || ^6`, so `astro check` breaks. Re-run those queries
  when revisiting; a remembered version number is a fabricated one.

## Out of scope

- Setting up or migrating audited sites. The tool checks; `--fix` (1.13.0) applies only the
  findings whose fix a check already measured, and everything else stays a suggestion.
  Scaffolding and migration are still out.
- Auto-firing hooks or an always-on contract.
- Per-site config inside audited projects — the tool reads what's there and adds no config
  of its own.

## Testing

Pure-Node tool (`tools/*.mjs`, no dependencies) plus **two** real Astro sites as test
targets:

- `examples/_fixture-i18n/` — the multi-locale exerciser. Two locales, search, a preview
  shelf, OG tooling. It exists to make checks fire on shapes a simple site never has.
- `examples/starter/` — the single-locale reference, and what create mode copies. It is
  the baseline's *existence proof*: the checks say what compliant means, and this is a
  site that is. It must stay `0 🔧 / 0 🛑` under `--strict`, enforced in CI.

**Raising the baseline means upgrading BOTH in the same commit.** Both run Astro 7
(`npm install && npm run build && npm run check` green), and a floor moved in only one of
them makes the other's clean run a lie.

The honest cost of the second site: two lockfiles, two `@astrojs/upgrade` runs per bump,
double Dependabot noise, and roughly double CI wall-clock. Mitigated with a
`[_fixture-i18n, starter]` matrix and `cache: npm` on `actions/setup-node`. Worth paying:
the alternative is a starter that quietly stops complying with the tool that ships it.

- **The gate: `node tools/test.mjs`.** Runs the audit against **both example sites** and a
  non-Astro dir and asserts the engine behaves (0 required findings on the fixture and on
  the unbuilt starter in default *and* `--strict`, the starter carries every
  `BASELINE_DEPS` entry and no invented credential, scoping works, non-Astro rejected).
  It also holds the **rule catalogue** honest in both directions: every id a run emits is
  catalogued, *and* every catalogued rule has a check that emits it — the second is what
  stops a renamed check leaving a dead row behind, as `images/optimized` did. Plus: no
  rule an offline run emits may be catalogued as needing `--url`, which is what keeps
  `mode` from drifting into a comfortable lie.
  Exit 0 = green. Stays offline so it works keyless and airgapped.
  Run it before every commit that touches `tools/**`.

  It also builds throwaway **known-bad** projects in `$TMPDIR` and asserts each check
  *fires*. This half matters: the compliant fixture only ever proves a check stays quiet,
  which passes just as happily when the check is broken. **A new check needs both halves.**

- **Manual offline:** `node ../../tools/audit.mjs` run *inside* `examples/_fixture-i18n/`. No
  flag runs all seven offline domains; `-s <name>` scopes to one. The fixture should return
  `0 🔧 / 0 🛑` — `💡` suggestions are fine, they don't count. If the fixture is flagged,
  the tool has a bug (or the fixture drifted). Check **both** modes: the fixture is fully
  compliant, so `--strict` must be clean too.

- **Dogfooding: run it against a real site you did not write for it.** The two examples
  are compliant *by construction*, so they can only ever prove a check stays quiet. The
  synthetic known-bad projects prove it fires on a shape you thought of. Neither catches
  the thing that actually goes wrong, which is a check firing on correct code in a shape
  nobody anticipated.

  Round 3 (2026-08-03, against `matewishkey-web` and `cypruspokerbrisbane-web`) is the
  example: the new quote lint put 19 findings on one site, and every one was a possessive
  apostrophe inside a quoted YAML description — frontmatter is not prose, and `’` is not
  a quotation mark. Both fixed, both now regression-tested. Nothing in the fixture, the
  starter, or the synthetic cases could have shown that. The same round confirmed
  `perf: font:styles` firing correctly on a real site and `perf: embed:eager` staying
  quiet on one that had already moved its Maps iframe behind a facade.

  Round 4 (2026-08-03) widened it to every Astro project on the box — six, spanning
  Astro 5.18 through 7.1 — and is the round that proves the *severity split* works rather
  than any single check. Five of the six are below the 7+ baseline and every one of them
  reported `💡 modules: astro:version … [baseline]`, not a finding: a stranger on Astro 6
  does not get a red build. Four sites fired a total of 19 🔧 and, on inspection, all 19
  were real gaps — no false positive to fix, which is the first round that could say so.
  Widening the sample costs one loop over `~/projects`; do it each time the check set moves.

  Round 5 (2026-08-04, `images: srcset:missing`) is the one to copy when a check needs a
  **threshold**, because a pass/fail sweep is the wrong instrument for one. Run the
  candidate *population* out of the real builds first and look at the distribution, then
  put the number in the gap between the two clusters. Here that was every single-width
  built `<img>` by intrinsic width and bytes: the ones meant to be one size stopped at
  720 px and the ones needing a ladder started at 1200 px, so 1000 px is a measured
  boundary rather than a round number, and the same run named the two false positives the
  guards then had to exclude. A number picked first and sanity-checked after would have
  shipped 640 px (the neighbouring check's floor) and fired on correct code.

  Round 6 (2026-08-06, AVIF in `tools/lib/image-size.mjs`) is the one to copy when a check
  reads **bytes**, where the real-site loop above proves nothing: no repo on the box builds
  to avif, so every site passed the check identically before and after. Two instruments
  replace it. First, parse real encoder output — libvips and ffmpeg disagree about box
  order and about which brand they put in `ftyp`, so a parser that only ever saw its own
  test fixtures is a parser tested against your own assumptions. Then convert a real build
  to the format under test (133 artifacts of `tasmanvisa-web` webp → avif with `sharp`,
  references rewritten) and diff the audit against its unconverted twin: identical output
  is the assertion, and any difference is a format assumption hiding somewhere. Second,
  cross-check widths at volume — 80 real build images re-encoded, each parsed size matched
  against both the webp the site shipped and what libvips reports, 0 mismatches. And when
  the point of the work is a *silent* blind spot, prove the silence existed:
  `git archive HEAD tools | tar -x -C <tmp>` gives you the old tool to run beside the new
  one on the same input.

  Round 7 (2026-09-03, promoting `images: srcset:missing`) is the one to copy when the
  loop over `~/projects` has run out of road. The promotion condition was *a wider sweep
  showing it stays quiet on correct code*, and issue #21 had recorded it as unmeetable
  from this box: every Astro site here had already been swept. That was true of **sites we
  wrote**, and only of those — which is the trap, because our own sites share our habits
  and therefore cannot contain the shape a false positive needs. **The corpus is not the
  box.** `gh search repos --sort stars "astro blog theme"`, shallow-clone, `npm install`,
  `npm run build`, audit. Expect roughly half to fail: 16 **public** repos attempted, 7 built (Starlight
  plugin monorepos need a workspace build, several installs fail outright), which is still
  seven sites nobody here wrote for one afternoon. It answered the question the internal
  loop could not — 43 measurable candidates, 18 findings, **0 wrong** in the public round
  alone, and 66/25/0 counting the three internal builds from #12's round with it — and, decisively, the
  byte floor firing on exactly the shapes it was designed against, found in the wild rather
  than constructed (a 1200 px / 27 KB quote graphic, a 1190 px / 24 KB logo, a 1096 px /
  5 KB placeholder). Two cautions. Building a stranger's repo runs its postinstall and build
  scripts, so do it in a scratch dir and never under `~/projects`. And keep the built corpus
  — the next threshold round wants the same population, and re-cloning is the slow part.

  Round 8 (2026-09-04, the sitemap checks and the seven competitor blind spots) added a
  **cheaper corpus and the one rule that governs it.** Cloning and building a stranger's
  repo is slow and runs their postinstall; for any check that reads `dist/` HTML you can
  instead *mirror* a live site — fetch its `robots.txt` and sitemap, fetch the pages, write
  them into a throwaway `dist/` with a stub `package.json` and `astro.config.mjs`, and point
  the audit at that. Six real sites in minutes, no build, no code executed.
  **`node scripts/mirror-corpus.mjs <out-dir> <url…>` is that**, and
  `https://astro.build/showcase/` is a ready-made list of real Astro sites to point it at
  (29 of them; round 9 mirrored 27). Do it in a scratch dir — the corpus is large and
  disposable.

  **The rule: a sampled mirror is only valid for per-page checks.** Anything whose subject
  is the *link graph* or *cross-page uniqueness* — `links:internal`, `links:orphan`,
  `sitemap:coverage`, `meta:unique:*` — needs a **complete** corpus, because every page you
  did not fetch looks like a broken link or a missing sitemap entry. An 8-page sample of a
  57-page site reported 115 false broken links; the complete mirror of the same site
  reported zero. Mirror the whole sitemap when it is small enough (≤ ~60 pages) and confine
  the sampled mirrors to the per-page checks. That round also cost two bugs of our own,
  both invisible to the bundled examples because both examples link with absolute paths and
  neither embeds an SVG: a relative href must resolve against the page's **URL**, not its
  file path, and `existsSync` answers *true for a directory*. Neither could have been found
  on a corpus we wrote — which is the same lesson as round 7, arriving by a different road.

  Round 9 (2026-09-04, issue #35) is the one to copy when the question is **whether to
  widen a check at all**, and it is the round where the corpus answered a different
  question than the one asked. The ask was a population containing the false-positive
  shape; the instrument was two copies of the tool on the same input (round 6's method) —
  `git archive HEAD tools` for the shipped one, a one-line patch for the candidate — over
  27 mirrored showcase sites. Result: 494 candidates, 311 declaring a width, **0 findings
  changed**. A null result is not a verdict on its own, so two things had to happen before
  it counted. **First, a positive control**: a fixture carrying exactly the shape, proving
  the widened tool fires on it and the shipped one does not — without that, "0 findings"
  is indistinguishable from a broken probe. **Second, look at the population you did
  measure, not just the delta**: the 311 were all one host, all `?width=600&dpr=2`, and
  fetching one showed 1200×720 — the declared width was half the delivered one. That
  killed the widening on a better argument than the null result, and turned up a real
  defect in shipped code, since `dpr` is Cloudflare's own parameter and our check ignored
  it. **The corpus is cheap enough to be worth building even when you expect to change
  nothing** — astro.build/showcase is 29 live sites, the mirror is minutes, and the
  by-product was worth more than the answer.

  **Most sibling repos have no `dist/` and the dist-reading checks are the interesting
  half**, so a real-site round usually means building them. Check `git check-ignore -q dist`
  first and skip any repo where it is not ignored — building there would drop hundreds of
  untracked files into someone's working tree. Two of the four Astro repos on the box
  failed that test in round 5.

  **Audit those repos, never edit them.** A checkout next door is not permission; anything
  found goes back as an issue filed into that repo.

- **The severity split.** `tools/lib/policy.mjs` decides which checks are universal and
  which are house style; house-style findings demote to `💡 [baseline]` unless `--strict`.
  A new check that isn't classified there defaults to universal — i.e. it will fail the
  build of every stranger who doesn't share the opinion. Classify deliberately.

- **Live (`--url`):** `node ../../tools/audit.mjs --url http://localhost:4321` — HTTP checks of
  the served site. Cache-header checks need a prod-like server (`wrangler dev` of `dist/`,
  or a deployed site); a plain `astro dev` doesn't apply `_headers`.

- **Lighthouse:** need network, a key, and a public URL — deliberately **not** in
  the offline gate. Without a key each leg `⏭ skips` and the run still exits 0. Lighthouse
  lab scores are noisy; re-run before trusting a number.

  **The key is provisioned on the dev box** — `$PAGESPEED_API_KEY`, in `~/.secrets`, with
  `mergodon/td-sops` (`apps/td-rider.enc.env` — the filename predates this repo's rename
  and is deliberately left alone; the `td-rider` repo it was named after was deleted on
  2026-08-03, the secrets file is the only thing that still carries the name) as the
  record. Rotate in both. It was absent
  until 2026-08-03, and that gap hid a real bug for a whole release: the diagnostics were
  written against a hand-built response, and the first live call showed Lighthouse had
  **renamed the audit ids** out from under them (`lcp-discovery-insight` etc.). A renamed
  id does not error — it produces a permanent `⏭`, which reads exactly like "nothing to
  report". **Any check that parses a third-party payload has to be run against the real
  API at least once**; a fixture only proves you can parse your own assumptions.

- **Runtime smoke (fixture-specific):** `node examples/_fixture-i18n/scripts/smoke.mjs` —
  Playwright against a live dev server (routes, SEO, search, locale boundaries).
  **It is not in the gate, and three things about running it will mislead you:**
  it needs a dev server on `:4321` and starts none, so a bare run fails every check;
  a *stale* dev server left on that port by an earlier session answers with old code, and
  its failures look exactly like real ones (this cost a wrong diagnosis on 2026-09-01 —
  pass an explicit base URL, `npm run smoke -- http://localhost:<port>`, and confirm the
  server serves your current content before believing a single result); and
  `en · no console pageerrors` fails on a COLD dev server and passes on the second run,
  because the first page load races Vite's dependency optimisation. Counts of posts do
  **not** belong in its assertions — one was hardcoded and adding a fixture post broke a
  test that was still checking the right thing.

- **The gate audits live too, since 2026-09-01 — `node ../../tools/verify-example.mjs` inside either example.**
  It builds the site, serves it the way its adapter demands, audits it with `--url`, and
  tears down; CI runs it `--strict` on both, with Chromium installed so the browser domain
  participates. It reaches roughly half as many checks again as the offline run,
  which is the whole reason it exists; `--rules --json` carries the split, and
  the exact figures are deliberately not written down here because they move
  with every release.

- **The `lighthouse` domain needs a PUBLIC url, and we keep one.** PageSpeed
  Insights fetches the URL from Google's side, so it can never reach the
  `127.0.0.1` the gate serves on — a local run answers `400` and the whole domain
  returns after one skip. CI has no `PAGESPEED_API_KEY` either, so there it takes
  the no-key branch. Between them, nine payload-parsing rules had never run
  outside one manual check (#30).

  `node scripts/test-site.mjs deploy` publishes `examples/starter` to
  **https://piy-rider-test1.promptityourself.com/** — copied verbatim and edited the
  four files create mode edits, so the thing measured IS the reference. Then
  `node scripts/test-site.mjs audit --strict` audits it with every domain live.
  Cloudflare free tier; ours for testing, and nothing in the plugin asks a user
  to set one up. **Redeploy after any change to the starter**, or you are
  measuring the previous one.

  It earned its keep on the first run: the starter's homepage hero was the LCP
  element and was lazy-loaded with no `fetchpriority`, which nothing offline can
  see. Measured 2026-09-03, after the fix: **109 ✅ / 0 🔧 / 0 🛑**, all ten
  domains, four Lighthouse categories at 100.

  It exists because the gate audited **offline only** for months, so `live`, `lighthouse`
  and `browser` — three of the ten domains — were never exercised against the two sites
  that are supposed to be the baseline's existence proof. The fixture was `0 🔧` offline
  and `1 🔧` live the whole time, its pages declaring an `og:image` that `scripts/og.mjs`
  never generated (#25). "Both examples are clean in every mode" was a claim about half
  the tool.

  ⚠ **Serving it correctly is the whole trick and getting it wrong is silent.**
  `@astrojs/cloudflare` splits the build into `dist/client` + `dist/server`, so pointing a
  static server at `dist/` hands out a **directory listing** and every check passes
  against nothing — a clean run that measured no site at all. That happened twice in one
  afternoon while this was still a manual recipe. `verify-example.mjs` sends a site with
  an adapter through `wrangler dev` (also the only way `_headers` is applied, so the cache
  checks mean anything) and a plain static build through its own server. Never
  `python -m http.server dist`.

- ⚠ **Two levels of quoting is where `tools/test.mjs` bites.** It writes helper servers out
  as template literals, so an escape survives only once: `/\/$/` becomes `//$/`, and
  `'a\nb'` gets a REAL newline inside a single-quoted string. Both shipped a server that
  would not start, and the second took every live assertion down with it. Build those
  strings with `String.fromCharCode(10)` and plain string ops rather than escapes.

- ⚠ **Astro's glob loader does NOT skip `_`-prefixed files.** `/preview/posts/_preview-project`
  serving 200 is the proof. The fixture's preview-only posts are kept out of the public
  blog by `previewOnly` frontmatter, and it is the frontmatter that decides — the shared
  `!draft && !previewOnly` predicate, the same one llms.txt, RSS and the search index use.
  Both `scripts/og.mjs` and the smoke test's post count filtered on the underscore instead
  and got the right answer anyway, because here the two rules select the same files. That
  is exactly how a wrong rule survives: it would have silently dropped the card for a
  `_notes.md` written without `previewOnly`.

- **`browser: nav:reach` needs a browser, and `tools/test.mjs` says when it did not get
  one.** The suite serves seven hand-built navs and asserts the check's verdict on each,
  but only where `examples/_fixture-i18n` has playwright AND a Chromium binary — they are
  two separate installs, `npm ci` for the module and `npx playwright install chromium` for
  the browser, and having the first without the second is the normal way to end up with
  neither. **CI's smoke job now does both**, so the check is exercised on every push
  rather than announced as skipped. Locally, missing either, the block prints
  `⏭ nav:reach not exercised` and names which one is absent. **A skipped gate that reads
  as a pass is the thing this repo exists to prevent, so it never reports one.**

### The examples cannot catch a false positive

Both example sites are compliant by construction, and the gate asserts they stay
`0 🔧`. That proves a check does not fire on correct code *of the two shapes we
wrote*. It cannot prove anything about the shapes we did not — and a false
positive is by definition a check firing on a shape nobody anticipated.

Measured on 2026-09-03: a review of the checks added the day before found **one
crash and eight false positives**, every one a required finding on correct
markup — an author written as a node reference into the same `@graph`, a
`CreativeWork` asked for a headline, a site that canonicalises to `www`, one
avatar with a two-rung `srcset` counted as three images. The suite was green
throughout. Both examples were green throughout. CI was green on every commit.

So the pre-ship line *"run it against a real Astro site that isn't the fixture"*
is not a nicety, it is the only step in the gate that can find this class of bug.
Audit several, and read the findings rather than the count: the question is not
"did it pass" but "is every one of these findings true".

And *"a real Astro site"* has to mean one **somebody else wrote**. The sites on this
box were built to this baseline, so they share its habits and cannot contain the shape
a false positive needs — a sweep over them proves the check agrees with us. Public repos
are the corpus that can disagree; § Testing round 7 has the method and the attrition
rate. The current dogfood sweep is the five built sites on this box, the deployed test site, the
six mirrored live sites from round 8, and
seven public builds kept in scratch.

### Pre-ship checklist

- [ ] If any `tools/**` changed: `node tools/test.mjs` passes.
- [ ] If any `tools/**` changed: `node ../../tools/audit.mjs` inside **both**
      `examples/_fixture-i18n/` and `examples/starter/` is `0 🔧 / 0 🛑`, in default
      **and** `--strict`. Build each first — most of the interesting checks read `dist/`.
- [ ] If any `tools/**` changed: `node ../../tools/verify-example.mjs --strict` inside **both** examples is
      `0 🔧 / 0 🛑`. It builds and serves for you, and it is the only thing that puts the
      `live`, `lighthouse` and `browser` domains in front of a real build — the offline
      run above reaches 7 of the 10 domains.
- [ ] If the baseline moved (a version floor, a required dep, a new check): **both**
      example sites were upgraded in this same commit. `tools/test.mjs` asserts the
      starter carries every `BASELINE_DEPS` entry, but it cannot assert taste.
- [ ] If a check was added: it's classified in `tools/lib/policy.mjs`, and sanity-checked
      against an off-baseline site so you can see which mode it lands in.
- [ ] If `commands/`, `skills/` or the starter's instructions changed: `node evals/run.mjs`
      passes. That is the only thing that asserts the *instructions* rather than the tool —
      create mode copying rather than composing, audit touching nothing, skips being
      reported, and `«…»` from an audited site being read as data. It needs a live model,
      so CI cannot run it; CI runs `--self-test` (the graders against synthetic
      transcripts, both directions) and parses every case file instead.
- [ ] If a doc states a rule's **severity**, it matches the catalogue — `tools/test.mjs`
      asserts this now, so a stale "advisory" fails the suite rather than waiting for a
      sweep. Two limits worth knowing. It only reads a claim where a **qualified** rule id
      (`images: srcset:missing`) and exactly one severity word sit within 60 characters of
      each other, so a line naming two rules is skipped rather than guessed at — that
      narrowness is what keeps it at zero false positives. And it cannot see prose that
      *describes* a check without naming it, which is how the original drift got in. The
      same run asserts every backticked file path in the docs resolves; a path belonging
      to an audited site rather than this repo (`robots.txt`, `/llms.txt`) goes in that
      test's `FOREIGN_PATHS` list, not into existence.
- [ ] If a **`browser`** check was added: it was run against hand-built pages for both
      verdicts, not just the failing one. Every false positive found there so far came
      from a page that was FINE — a trailing slash, a form's submit button, a collapsed
      `<details>` whose children still measure 58×17.
- [ ] If it introduced a **threshold**: the number sits in a gap you measured, and the
      run that measured it is written down. See round 5 above.
- [ ] If `tools/checks/*.mjs` changed: also run it against a real site — drift there is
      expected and informational, and it's how you confirm the check fires in the wild.
- [ ] If `skills/**`, `commands/**` or `.claude-plugin/**` changed: load the working tree
      as a plugin (`claude --plugin-dir ~/projects/piy-rider`) and run the command you
      touched end to end. `${CLAUDE_PLUGIN_ROOT}` is expanded in the markdown before the
      model reads it, and is **not** set in the shell — so a path that only *looks* right
      fails at the first Bash call, and nothing but running it will tell you.
- [ ] If **anything a consumer runs** changed — `tools/**`, `commands/**`, `skills/**`,
      `examples/starter/**`, `.claude-plugin/**` — `version` was bumped in the same commit,
      and it was verified through the marketplace, not just `--plugin-dir`. See § Releasing.
      Gating this on `.claude-plugin/**` alone was the bug: that path never changes for a
      new check, so six commits of user-visible work reached `main` unreleasable (#27).
- [ ] If create mode changed: scaffold end to end into an empty directory, let it build,
      and confirm the audit it runs on itself comes back `0 🔧`.

## Distribution

A dev tool — no deploy, no live UI. It ships as a **Claude Code plugin**, and this repo
is also the marketplace that serves it:

```
/plugin marketplace add promptityourself/piy-rider
/plugin install piy-rider@piy-rider
```

`.claude-plugin/plugin.json` is the manifest; `.claude-plugin/marketplace.json` is the
one-entry catalogue. `commands/`, `skills/` and everything they reach are discovered by
convention — nothing is registered by hand, and there is no installer to keep in step.

**Developing is not the same as consuming.** An installed plugin is a version-pinned copy
in `~/.claude/plugins/cache/piy-rider/piy-rider/<version>/`, so a `git pull` here does not
change it. Work against the tree instead:

```bash
claude --plugin-dir ~/projects/piy-rider
```

**But `--plugin-dir` reads the working tree, so it can never surface an install or
packaging bug** — the class of bug a consumer hits first. Anything touching
`.claude-plugin/**` or the layout of `commands/`/`skills/` has to be verified the way it
is actually consumed, through the marketplace.

### Releasing

**Bump `version` in `.claude-plugin/plugin.json` in the same commit as the change.** The
cache is pinned by *directory* — with no bump there is nowhere for an update to move to,
and the change is invisible to anyone who already has it installed. Then:

```bash
git push origin main
claude plugin marketplace update piy-rider   # refresh the catalogue from source
claude plugin update piy-rider@piy-rider     # move the pinned install
```

then **restart Claude Code** — the CLI says a restart is required and it means it.

Five things that look like bugs and are not:

- `claude plugin install` **no-ops when the plugin is already installed**. `update` is the
  only one that moves the pin; reaching for `install` wastes a round.
- `claude plugin update` **leaves the plugin DISABLED**, at least when it was disabled
  before. Both releases on 2026-09-01 came back `Status: ✘ disabled` after a successful
  update, and a disabled plugin is indistinguishable from one whose new version did not
  take. Check `claude plugin list` before believing a release landed.
- ⚠ **And `claude plugin enable` may not stick.** It writes `enabledPlugins` into
  `~/.claude/settings.json` — so if that file is GENERATED (chezmoi, Ansible, a dotfiles
  templater), the next apply reverts it and the plugin is disabled again at the following
  session start. The enable reports success, `claude plugin list` agrees, and it is gone
  by morning. That is what kept this plugin installed-but-disabled for four days, and
  reverted it three times in one afternoon while its own release was being tested. If the
  file is managed, add the plugin to the SOURCE template, not to the applied file — and
  confirm by running the apply twice: the second run must be a no-op.
- `claude plugin details` resolves from the refreshed *source* while `claude plugin list`
  reports the *installed pin*, so they disagree in the window between the two commands.
- `claude plugin tag` cuts a `piy-rider--v<version>` git tag and validates that
  `plugin.json` and the `marketplace.json` entry agree — run it if the two ever drift.

Pure Node ESM on system Node 22+, no dependencies, no `package.json` at the repo root.
