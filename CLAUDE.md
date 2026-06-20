# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SNAP//QUICKADD — a retro arcade-styled, **phone-only** Snapchat quick-add helper. Core flow: the user uploads a Quick Add **screenshot** or a **scrolling screen-recording**, a Claude vision model extracts the @usernames, the user **confirms/edits** the list, and each confirmed name becomes a real `snapchat://add/<username>` deep-link button. There's also an email/password account system, a Snapchat OAuth connection, an Added › Texting › Hangout funnel, a leaderboard, and a profile.

This is a real app with a Node backend — **run it with `npm start`** (serves on `PORT`, default 3000), not by opening the file. It is mobile-only: a desktop guard (`@media (min-width:768px) and (hover:hover) and (pointer:fine)`) hides the app on real desktops; use a phone or a narrow/touch viewport.

## Run / env

- `npm start` (or `npm run dev` for `--watch`). Copy `.env.example` → `.env`.
- **Snapchat OAuth** (`SNAP_CLIENT_ID`/`SECRET`): optional — without it, connect runs in DEMO MODE (simulated). Real Login Kit only exposes display name / Bitmoji / external id (no friends/location/gender), so discovery-by-criteria data is necessarily simulated.
- **Scanner** (`ANTHROPIC_API_KEY`, optional `SCAN_MODEL`, default `claude-opus-4-8`): required for vision extraction. Without it `/api/scan/extract` returns 503 and the UI falls back to manual username entry.
- No test suite.

## Architecture

Frontend is three static files (no framework, no bundler); backend is Express under [server/](server/).

- [index.html](index.html) — all views are in the DOM as `<section class="view" data-view="...">`: `home`, `qadd` (scanner), `stats`, `leaderboard`, `account`. Only one lacks `.hidden`.
- [styles.css](styles.css) — retro theme; tokens in `:root` (`--accent` red neon, grid via `body::before`). The `.app-shell` red border + grid is the visual identity.
- [script.js](script.js) — all client logic. `state` holds `user` (app account), `auth` (Snapchat), `funnel`, and `mutuals` settings; `funnel`/`mutuals` persist to `localStorage` (third-party scanned usernames never do).
- [server/server.js](server/server.js) — Express app + static serving. [server/snap-oauth.js](server/snap-oauth.js) (PKCE Login Kit), [server/accounts.js](server/accounts.js) (scrypt-hashed users in `server/data/users.json`, token email verification), [server/scan.js](server/scan.js) (vision extraction).

### How it fits together

- **Routing**: `go(view)` toggles `.hidden` and calls that view's `render*()`. Navigation is delegated off any `[data-go]` element.
- **Scanner pipeline** ([script.js](script.js)): `handleScreenshot`/`handleVideo` → `prepForVision` (canvas upscale/contrast, theme handled by the model) → `extractFromDataURL` (POST `/api/scan/extract`) → `mergeCandidates`. Video frames are sampled in-browser in `extractVideoFrames` (stable-frame + dedupe heuristic, capped). Results populate the **confirm/edit** list (`candidates`); on Confirm they become `qaddEntries` rendered as ADD cards. **The image/video never leaves the browser except as preprocessed frames sent to the model; the server holds them only in memory and writes nothing to disk.**
- **Mutuals filter**: `applyMutualView`/`applyMutualSort` operate on any `.mutual-list` (shared by the confirmed scan list and the Account settings), animated (collapse + FLIP) so toggling never shifts layout.
- **Funnel**: `openSnapAdd` opens the deep link and increments `funnel.added` (then probabilistic texting/hangout). Stats, leaderboard rank, and profile derive from it via `meEntry()`.

## Conventions

- Keep the scanner **ephemeral**: don't persist uploaded media or extracted third-party usernames (server-side or in `localStorage`).
- Vision/Anthropic code uses the official `@anthropic-ai/sdk`, model `claude-opus-4-8`, with structured outputs (`output_config.format`). Keep secrets in env.
- Match the `Press Start 2P` arcade aesthetic and the red-neon/grid token system; stay phone-first (single column, large tap targets, works in portrait + landscape).
