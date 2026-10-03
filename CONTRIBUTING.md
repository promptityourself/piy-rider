# Contributing to Mate Wish Key Rider

Thanks for looking. This is a small, deliberately dependency-free tool — the bar for changes is "does it make the tool's answers more trustworthy?"

## Licensing of contributions

By submitting a pull request you agree that your contribution is licensed under the [MIT License](LICENSE), the same terms as the rest of the project. Please don't paste in code from another project unless its licence permits it and you bring the required notice with it.

## Reporting a bug

The two worth reporting are the two this tool is designed against: a check that **flagged code that is correct**, and one that **stayed quiet on code that is not**. Also worth filing: a crash, a wrong exit code, a rule id missing from `--rules`, or docs describing behaviour the tool doesn't have. A finding you disagree with is *not* a bug — house-style checks already report as `💡` and never fail a run.

If you're running rider as a plugin, **`/mwk-rider:bug`** writes the report from what actually happened, redacts what shouldn't travel, shows it to you, and files it once you say yes. Otherwise: [open an issue](https://github.com/promptityourself/piy-rider/issues/new/choose).

Either way the useful part is the same — the **rule id**, and the **smallest snippet that reproduces it**. That snippet is what the regression test gets built from, so a report that has it is most of the fix.

Security issues go through [private reporting](SECURITY.md), never a public issue.

## Getting set up

There is nothing to install. You need Node 22 or newer, and that's it — no `npm install`, no root `package.json`, no API keys.

```bash
git clone https://github.com/promptityourself/piy-rider.git
cd mwk-rider
node tools/test.mjs          # the gate — must pass
```

That covers the tool and the offline audit. Three things are optional, and each one
buys a specific thing rather than being general setup:

| | what it unlocks | without it |
|---|---|---|
| `npm ci && npx playwright install chromium` in `examples/_fixture-i18n` | the `browser` domain, and the `nav:reach` assertions in the test suite | the suite prints `⏭ nav:reach not exercised` and stays green |
| `$PAGESPEED_API_KEY` (free) | the `lighthouse` domain | `⏭ lighthouse: psi` |
| **context7** — declared in this repo's `.mcp.json` | the Astro/Cloudflare doc lookups [step 1 of adding a practice](BEST-PRACTICES.md#how-we-add-a-practice) requires | nothing enforces the rule, which is how it went unnoticed that it was never wired |

context7 needs `CONTEXT7_API_KEY` in your environment; the repo declares the server, never
the key. `.claude/settings.json` likewise *recommends* the `frontend-design` and
`plugin-dev` plugins rather than requiring them — Claude Code asks before enabling either,
and neither is needed to run the tool or the gate.

## The two rules that matter

**1. A new check needs both halves of a test.** `tools/test.mjs` asserts that checks stay quiet on the two compliant example sites — `examples/_fixture-i18n/` and `examples/starter/` — *and* that each one actually fires on a purpose-built known-bad project. A compliant site alone proves nothing: a check that is broken and never fires passes it just as happily as one that works.

And if your change moves the baseline, **both example sites are upgraded in the same commit**. `examples/starter/` is what `/mwk-rider:create` copies to create a site, so a starter that has fallen behind the checks ships non-compliant sites to people who trusted it.

**2. A new check must be classified in `tools/lib/policy.mjs`.** Is it universal practice, or this project's house style? Anything unclassified defaults to universal, which means it becomes a required finding that fails the build of every stranger who doesn't share the opinion. Ask: *could a well-built Astro site reasonably do this differently?* If yes, it's house style — it reports as `💡 [baseline]` and only bites under `--strict`.

The full five-step process for adding a practice, and the reasoning behind each existing one, is in [`BEST-PRACTICES.md`](BEST-PRACTICES.md#how-we-add-a-practice). The governing rule there: every practice has an enforcing check, and a practice with no check is a tracked *gap*, not a practice.

## Things this tool deliberately does not do

Please don't add these — they've been considered and rejected:

- **Execute the audited project's source.** Config is read as text and parsed, never `import()`ed. Auditing a repo must never be equivalent to running it. See the safety note at the top of `tools/lib/project.mjs`. The one exception is deliberate, bounded and disclosed in the output: the optional `browser` domain imports `playwright` from the project's `node_modules` when the auditor has no copy of its own — see the header of `tools/checks/browser.mjs` and [`SECURITY.md`](SECURITY.md). Adding a *second* exception needs the same treatment, and a very good reason.
- **Write to the audited project *unasked*.** A plain run reports and the user decides. `--fix` (1.13.0) is the user deciding, and it is narrow on purpose: it applies only findings whose fix the check already measured, then re-runs the audit and reverts the lot if anything regressed. What stays rejected is auto-fixing — nothing writes without the flag.
- **Take a runtime dependency.** Node built-ins only. This is why it can be run with a single `git clone` and no install step.
- **Fire automatically.** No hooks, no always-on contract. You run it when you want an answer.

## Two failure modes to design against

The worst things a check can do are miss a real violation and flag a compliant site. Both destroy trust in every other finding. So detection should accept *correct variants*, not one spelling — a site whose head metadata lives in `BaseHead.astro` rather than `SEO.astro` is not wrong, and a check that assumes the filename is.

When a check can't determine an answer, report `⏭` with the reason. Never let a check silently not run: in the output, "checked and passed" and "never checked" must never look the same.

## Before you open a PR

- [ ] `node tools/test.mjs` passes.
- [ ] `node ../../tools/audit.mjs` inside **both** `examples/_fixture-i18n/` and `examples/starter/` is `0 🔧 / 0 🛑`, in default **and** `--strict`.
- [ ] `node ../../tools/verify-example.mjs --strict` inside **both** examples is `0 🔧 / 0 🛑`. CI runs this, so
      an offline-only pass can still go red — it is the only thing that exercises `live`,
      `lighthouse` and `browser` against a real build.
- [ ] Any new check is classified in `tools/lib/policy.mjs` and has both test halves.
- [ ] You ran it against a real Astro site that isn't the fixture, and the result made sense.

More detail on testing and the design decisions: [`docs/DEVELOPING.md`](docs/DEVELOPING.md).
