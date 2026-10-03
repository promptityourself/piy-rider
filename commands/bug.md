---
description: Report a bug in rider itself — a check that fired on compliant code, missed a real violation, or crashed.
argument-hint: "[what went wrong, if you already know]"
---

Something in **rider** is wrong and it should be filed. Write the report out of
what actually happened in this session — you were there, the reporter's memory
of it is worse than yours.

What they said, if anything: `$ARGUMENTS`

## 1. First: is it actually rider's bug?

Three different things get called "a rider bug" and only one belongs here.

- **Rider is wrong.** A check fired on code that is correct (**false positive**),
  stayed quiet on code that is not (**false negative**), crashed, exited with the
  wrong code, printed a rule id that isn't in `--rules`, or the docs describe
  behaviour the tool doesn't have. **That is a bug. Carry on.**
- **Rider is right and the finding is unwelcome.** The check found a real problem
  in their site. That is the tool working. Don't file it — offer to fix the site
  instead. A `💡 [baseline]` they disagree with is house style, not a bug either:
  it already doesn't fail their run, and `--strict` is opt-in.
- **Claude Code itself, or another plugin.** Say so plainly and point at
  <https://github.com/anthropics/claude-code/issues>. Filed here it lands where
  nobody who can fix it will read it.

The two that matter are the first kind, because [`CONTRIBUTING.md`](../CONTRIBUTING.md)
names them as the failure modes worth designing against: **a check that flags a
compliant site, and one that misses a real violation, both destroy trust in every
other finding.** Say which one this is in the title.

If you genuinely can't tell, say which you think it is and let them decide.
Don't file on a guess.

## 2. Get the facts yourself

Don't interview them. Go and look.

- **The finding line, verbatim** — the whole `🔧`/`🛑`/`💡`/`⏭` line including
  the rule id (`seo/headings-order`, `images/srcset-missing`, …). The id is the
  single most useful thing in the report; without it the fix starts with a search.
- **The machine-readable form** of just that domain, which carries the id,
  outcome, message and file together:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/tools/audit.mjs" -s <domain> --json
  ```

- **The code the check misread** — the smallest snippet of their `src/` or built
  `dist/` HTML that reproduces it. For a false positive this *is* the bug report:
  it's what a regression test gets built from, and `tools/test.mjs` requires a
  known-bad (or in this case known-good) case for every check.
- **Whether it reproduces.** Run it again if that's quick and safe. "Every run"
  and "once" send the reader down different paths.
- **Versions and how rider is loaded** — `version` from
  `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`, `node --version`, and
  whether this is the installed plugin or a `--plugin-dir` working copy. A
  working copy may be ahead of `main`; say so and name the commit.
- **For a `--url` finding only** — which of `live` / `lighthouse` / `browser`,
  and whether `$PAGESPEED_API_KEY` was set and `playwright` installed. Those
  three domains skip cleanly when they're missing, and a skip misread as a pass
  is its own bug.

## 3. Take out what shouldn't travel

**The issue is public.** Before they see it, and before it is sent:

- **Home folder paths → `~`.** `/home/<name>` and `/Users/<name>` carry a name.
- **Never include `$PAGESPEED_API_KEY`** or any other key, token or password —
  anything long and random, anything after `Bearer`, anything from a variable
  named `KEY`, `TOKEN` or `SECRET`. Replace with `<removed>`. Rider reads exactly
  one operator secret and this is the one place it could leak.
- **The audited site's URL**, if it isn't public yet or they'd rather not name it.
  A `--url` bug usually reproduces from the served HTML, not the hostname.
- **Their content**, beyond the minimal snippet that reproduces. A file name is
  usually enough.
- **Keep the error text and the finding line intact.** Over-redacting those makes
  the report worthless.

## 4. Show them, then ask

Print the whole report — title and body — and say, in a line or two:

> This goes to a **public** issue on GitHub, under your GitHub name. Send it?

**Wait for a yes.** Never file silently, never file a report they haven't read.
If they want something out, take it out and show them again.

## 5. File it

```bash
gh issue create -R promptityourself/piy-rider -t "<title>" -b "<body>"
```

Title it as the failure mode plus the rule id — `false positive: seo/headings-order
fires on …` — so the queue reads at a glance. Give them the link it prints.

**If `gh` isn't set up**, don't make that their problem: save the report next to
their work, tell them the path, and give them
<https://github.com/promptityourself/piy-rider/issues/new/choose> for when they are.

## 6. Then unblock them

A filed bug doesn't fix their afternoon. If there's a way round it now, do that —
for a false positive that's usually `-s` to run the other domains, or dropping
`--strict`. The report is so it stops happening to the next person, not instead
of helping this one.
