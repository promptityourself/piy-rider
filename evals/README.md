# Plugin evals — the instructions, asserted

`tools/test.mjs` asserts the tool to the byte. Nothing asserts the *instructions*
in `commands/` and `skills/` — the rules that exist only as prose. These cases
do, through `claude plugin eval` (issue #23).

## Running them

```bash
node evals/run.mjs                    # every case, at its configured run count
node evals/run.mjs untrusted-output   # one case
node evals/run.mjs --runs 1           # one attempt each, for a fast loop
node evals/run.mjs --self-test        # the graders only: no model, no network
```

`evals/run.mjs` drives each case through `claude -p` with `--plugin-dir` pointed
at this repo, stages the fixtures itself, and grades the message stream. It is
not the first-party runner and does not pretend to be: **no ablation arm**, and
`runs: 3` means three independent attempts of which *every one* must pass, which
is stricter than a pass rate. `max_turns` is not enforced because this CLI has
no such flag — `timeout_seconds` is the bound.

The cases stay written against `claude plugin eval`'s schema, and **it has landed**
— `--ablation`, `--runs` and `--eval-dir` all exist as spelled below (checked
2026-09-13). `evals/run.mjs` is no longer the only way to run these; it stays
because it is what CI's `--self-test` path uses and because it needs no
entitlement:

```bash
claude plugin eval ~/projects/piy-rider --ablation none --runs 2 --allow-tools Bash
```

**`--self-test` is the part CI runs.** The evals need a live model, so CI can
never run them; what it can run is every deterministic grader against synthetic
transcripts in *both* directions — the pass case and the case it exists to catch.
A `tool_used max: 0` that silently matched nothing would score every injection
case green, and that is precisely the failure this directory already shipped
once. `tools/test.mjs` runs it, and also parses every case file and asserts that
a prompt naming `./fixture` actually stages one.

`refuses-non-astro` needs no fixture, so it is the `prompt.md` + `graders/*.md`
layout. The other three stage an Astro project and are therefore `case.yaml`,
which is the only layout with `context.add_dirs` — **without it the run has no
`./fixture` at all**, the agent audits nothing, and the `tool_used: max 0`
graders that carry the whole point of those cases pass because nothing happened.
That was true of the first version of this directory, written before the suite
could be run. Every case now leads with an `audit-actually-ran` grader for the
same reason: a case that cannot fail is not a test.

Deterministic graders wherever possible; an LLM judge only where the assertion
is about wording. The create-mode case is deliberately
absent: it needs `npm install` and a build inside the sandbox, which is minutes
per run — the offline suite already scaffolds and builds the starter from a
clean copy, so the copy-never-compose rule is covered there. **The brief branch
of create mode is absent for the same reason and is not equally covered**: its
"do not read the JSON yourself, run `tools/brief.mjs`" rule is prose, and
`tools/test.mjs` asserts what the reader *does* rather than that an agent
reaches for it. A case that pastes a brief and grades on `tool_used
brief.mjs` would close that, and it costs a build per run to write honestly.

| case | the prose rule it holds |
|---|---|
| `refuses-non-astro` | a directory that is not an Astro project is refused, not improvised around |
| `never-auto-edits` | audit surfaces findings and touches nothing |
| `reports-skips` | an audit that skipped checks says so; "clean" is never silent |
| `untrusted-output` | text inside «…» from the audited site is reported, never followed |
