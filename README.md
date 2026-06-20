# SNAP//QUICKADD

Retro-arcade, phone-first Snapchat quick-add helper. Upload a Quick Add
**screenshot** or a **scrolling screen-recording**, a Claude vision model extracts
the @usernames, you confirm/edit, then add them via Snapchat's HTTPS universal
link (one tap, no app-scheme warning, no new tab). Plus: manual stat logging,
a real-user leaderboard, XP/levels/streaks/achievements/skins, SUPERBAD flags,
and an account system with persistent sessions.

## Stack
- **Server:** Node + Express ([server/](server/)). No frontend build step — the
  client is plain static HTML/CSS/JS ([index.html](index.html), [script.js](script.js), [styles.css](styles.css)).
- **Vision:** Anthropic SDK (`claude-opus-4-8`), called server-side only.
- **Storage:** flat JSON ([server/data/users.json](server/data)) with atomic writes + `.bak`;
  file-backed sessions (survive restarts). Swap for a DB to scale.

## Run locally
```bash
npm install
cp .env.example .env        # fill in keys (works in DEMO mode with blanks)
npm start                   # http://localhost:3000   (npm run dev = --watch)
```
- **Phone testing:** open `http://<your-LAN-IP>:<PORT>/` on a phone on the same Wi-Fi.
- The scanner needs `ANTHROPIC_API_KEY`; without it the UI falls back to manual entry.
- Snap connect works in DEMO mode without `SNAP_CLIENT_ID` (simulated).

## Deploy (production)
1. Set env (see [.env.example](.env.example)): `NODE_ENV=production`, a strong
   `SESSION_SECRET`, `COOKIE_SECURE=true`, `ANTHROPIC_API_KEY`, and the Snap
   Login Kit creds with a **public HTTPS** `SNAP_REDIRECT_URI` registered in the
   Snap dev portal.
2. Serve over **HTTPS** (required for Secure cookies and the clipboard API). Put
   it behind a TLS-terminating proxy; `NODE_ENV=production` sets `trust proxy`.
3. `npm ci && NODE_ENV=production npm start` (or a process manager / container).
4. Persist `server/data/` (accounts + sessions) on a durable volume.

### Hardening already in place
- Rate limiting on `/api/scan/extract`, `/api/account/login`, `/api/account/signup`.
- Upload validation: data-URL + size cap (~6.7 MB/frame); client caps video frames.
- Security headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`),
  `x-powered-by` disabled, JSON 404 + catch-all error handler (no detail leak),
  `unhandledRejection`/`uncaughtException` guards.
- Secrets only in env; OAuth tokens live in the server session, never sent to the
  browser; `.env` and `server/data/` are gitignored.

## Privacy notes
- Uploaded images/video are processed in the browser and sent only to the vision
  model; **never written to disk** server-side. Extracted third-party usernames
  are ephemeral except the user's own add/skip history and SUPERBAD flags, which
  are saved to their account.
- Group info is only ever read from this app's own user data — never scraped.

## Known external limits (not bugs)
- **Instagram** has no public deep link to open the app's search pre-filled — IG
  Lookup opens the app and copies the name for a one-tap paste.
- Snapchat **Snapcode** generation needs Snap's API; the share view shows a plain
  QR of the user's `snapchat.com/add/<username>` link instead.
# quickadd
