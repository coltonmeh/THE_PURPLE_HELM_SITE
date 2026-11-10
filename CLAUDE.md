# CLAUDE.md: The Purple Helm league site

This is the **public** website for Colton's fantasy league. It is separate from his private model repo (`coltonmeh/purple-helm`), and that repo's PRODUCTION/R&D rules do not apply here.

## Hard rule: nothing private goes in this repo
Everything here is readable by anyone. Never add:
- Colton's dollar model, price tiers, trade targets or FAAB bid model;
- notes about league managers;
- anything from 4for4 or Draft Sharks (paid sources);
- credentials, emails or account exports.

Inputs are limited to the Sleeper API, FantasyCalc's public values and `fair_history.json`.

## How changes ship (proposed by Claude on Nov 10, 2026; Colton has not changed them)
- A push to `main` rebuilds and publishes the site within a couple of minutes. There is no staging site.
- **Small changes go straight to `main`:** wording, layout, a new column, a bug fix.
- **Changes to how numbers are calculated are shown to Colton first:** the verdict rule, the odds, pick and keeper values. Publish a private preview page for him, then push when he says go.
- Before pushing: `python build_data.py && python build_page.py && node test_scen.js`, and look at the page at phone width.
- The scheduled build must keep working. A check that depends on simulation noise or on a named player belongs in the soft set (`PH_SOFT`), so it can't stop the site from updating.

## Things to know
- Sleeper asks that the full player list be pulled at most once a day. The workflow keeps the `cache/` folder between runs for that reason. Don't shorten that file's refresh time.
- The league rules page (`rules.html`) is a copy of the commissioner's Google Doc. Re-copy it when the doc changes; the doc is the official version.
- Open work and method notes are in `README.md`.
