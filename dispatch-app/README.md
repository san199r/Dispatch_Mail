# Dispatch Board — local app

A standalone cold-email outreach tracker that runs on your own machine. Contacts,
sending desks, email templates, and the follow-up schedule are stored in a real
**SQLite database** (`dispatch.db`) on disk — nothing is in the cloud.

## Requirements

- **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module). You have
  Node 25, so you're set. Check with `node --version`.
- No `npm install` needed — there are **zero external dependencies**.

## Run it

From this folder (`dispatch-app`):

```
npm start
```

or equivalently:

```
node server.js
```

Then open **http://localhost:4173** in your browser.

Stop the server with **Ctrl+C**. Your data stays in `dispatch.db`.

To use a different port: `PORT=5000 node server.js` (PowerShell: `$env:PORT=5000; node server.js`).

## What it does

- **Sending desks** — each desk is a persona with its own editable subject +
  email body. Six are seeded on first run (Noal, Julie, Stacy, Rajini, Asha,
  Everett); add, edit, or delete freely.
- **Contacts** — paste `Name, email, market` in bulk or add one at a time.
- **Auto-assign** — spreads contacts evenly across desks, one desk per contact.
- **Follow-up rules** — a review-and-send cadence (default day 3 / 6 / 10); the
  board flags contacts as "Follow-up due" as each threshold passes.
- **Per-contact view** — previews the composed email with placeholders filled,
  copy to clipboard or open in your mail app, and log sent / replied.
- **Stats, filters, search, CSV export** across the whole board.

Nothing sends email by itself — this is a dispatch/tracking board. You send from
your own mail client and click "Mark sent."

## Files

| File               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `server.js`        | Local HTTP server + SQLite persistence + REST API   |
| `public/index.html`| The full UI (single page)                           |
| `dispatch.db`      | Your data (created automatically on first run)      |
| `package.json`     | Metadata + `npm start` script                       |

## Back up your data

Just copy `dispatch.db` somewhere safe. To start fresh, stop the server and
delete `dispatch.db` (and any `dispatch.db-wal` / `dispatch.db-shm` files).
