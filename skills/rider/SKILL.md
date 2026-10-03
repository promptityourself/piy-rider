---
name: rider
description: Create a new Astro site from a compliant starter, or audit an existing one against baseline best practices — the stack, SEO, images, page speed, analytics, and the machine-readable surface (JSON-LD, llms.txt, RSS). Use it to build a site, scaffold a blog, or run a compliance check from inside any Astro project. Optional argument is a live URL to also check the served site.
---

## Which mode

**Create** — the user wants a *new* site ("build me a site", "scaffold a blog", "set up an Astro project"), or the current directory is empty / not an Astro project and they are not asking for an audit. Read `references/CREATE.md` (next to this file) and follow it. Stop reading here.

**Audit** — everything else: the current directory is an Astro project and the user wants to know what is wrong with it. Read `references/AUDIT.md` (next to this file) and follow it. The argument, if any, is a base URL to also audit live.

If it is genuinely ambiguous, ask — one question, then commit to a mode.

This router exists for the model-invoked path, where the mode has to be inferred. A user who types `/piy-rider:create` or `/piy-rider:audit` has already chosen, and those commands load the same two files directly — one set of instructions per mode, never a second copy.
