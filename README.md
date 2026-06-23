# Top Chicken Labeller 🐔

A Bluesky labeller that badges the reigning **Top Chicken**, the all-time record
holder (**TipTop Chicken**), and everyone who's ever held the crown.

## Labels not showing up? (AppView ingestion / Vortex)

The Bluesky AppView ingests third-party labels via an internal service (**Vortex**)
that opens a `subscribeLabels` websocket per labeler and keeps a **per-labeler
resume cursor**. Two consequences bite this project:

- **Backfill labels can be stranded.** The backfill runs as a *separate process*
  from the running server, so its `createLabels` writes rows to the DB but never
  broadcast live on Vortex's open connection. If Vortex's cursor is at/past them,
  they're never ingested. Fix: set `REEMIT_LABELS=1` and redeploy once — the
  *running* server re-emits the current effective active set as fresh higher-seq
  rows that broadcast live (and sit above any cursor). Then unset it (otherwise it
  re-emits on every boot). This is the fix Bluesky's own labeler ops prescribe
  ("re-emit the labels and advance the cursor").
- **A brand-new labeler may take a while to be picked up at all.** Vortex
  discovers labelers from the AppView's indexed `app.bsky.labeler.service` record
  and reloads them (notably on its own restart). Until Vortex opens a connection,
  nothing we emit is ingested — labels are correct and served by our `queryLabels`
  but simply don't appear on profiles yet. There is no self-service way to force
  this from outside; cursor surgery is Bluesky-internal. Verify our side is
  correct (below) and wait, or ask a Bluesky engineer to kick Vortex.

Verify our side is healthy independent of the AppView:

```bash
# labeler declared + indexed:
curl "https://api.bsky.app/xrpc/app.bsky.labeler.getServices?dids=<LABELER_DID>&detailed=true"
# labels actually served + signed:
curl "https://<host>/xrpc/com.atproto.label.queryLabels?uriPatterns=<subject-did>"
```

If those return the labels but a profile (with `atproto-accept-labelers: <did>`)
doesn't, the gap is Vortex ingestion, not this service.

## What's a Top Chicken?

A Bluesky meme. Each day, one account earns the crown: the account under the
**7,000-follower "Grace Limit"** whose post got the most likes in a rolling 24h
window (evaluated with a ~12h delay). The candidate pool is the tracker's
following + followers. It started from Grace ([@gracekind.net](https://bsky.app/profile/gracekind.net))
saying "gm top chickens" in 2024.

The crown is tracked publicly by two accounts in sequence, which post
`🐔 New Top Chicken! @handle's post got N likes.` with the winner's DID embedded
as a mention facet:

| Tracker | Window |
| --- | --- |
| [@dave.9000ish.uk](https://bsky.app/profile/dave.9000ish.uk) | 2026-05-08 → 2026-06-06 |
| [@topchicken.bsky.social](https://bsky.app/profile/topchicken.bsky.social) | 2026-06-06 → present |

This project does **not** recompute the crown. It mirrors that canonical signal
and turns it into actual labels you can subscribe to in-app.

## Labels

| Value | Meaning | Behavior |
| --- | --- | --- |
| `top-chicken` | The current daily holder | Single-holder. Negated off the old holder and applied to the new one each time the crown moves. |
| `top-chicken-alumni` | Has ever held the crown | Sticky. Only ever added. |

Both labels are applied to **account DIDs** (not posts) at severity `inform`
(neutral badge, no blur).

## Architecture

One long-lived Node process (single Railway replica):

1. **`LabelerServer`** ([@skyware/labeler](https://github.com/skyware-js/labeler))
   serves `com.atproto.label.queryLabels` + `subscribeLabels`, signs labels with
   the account's secp256k1 key, and persists them to a SQLite/libsql file.
2. **Poller** reads the live bot feed every `POLL_INTERVAL_MS`, parses the latest
   crowning, pulls the winner's DID from the mention facet, and transfers the
   crown when it changes.

State:

- `labels.db` — the signed label log + `subscribeLabels` cursor (libsql file).
- `state.json` — the current holder DID, so we know whom to negate on a move.

Both live on the Railway volume. **Single replica is required** — Railway volumes
can't attach to multiple replicas, and a labeller must have exactly one writer /
one cursor sequence anyway.

DIDs (not handles) are the identity key throughout, pulled from the announcement
mention facets. This is self-healing across handle renames — e.g.
`codetard.bsky.social` renamed to `vibe-coded.com`; same DID, same single alumnus.

## Source layout

```
src/
  config.ts      env + meme constants
  crownings.ts   fetch + parse crowning announcements (shared)
  labelDefs.ts   the two LabelValueDefinitions
  labeler.ts     transferCrown / grantAlumni (shared crown logic)
  state.ts       holder state file read/write
  index.ts       the service: LabelerServer + poll loop
  backfill.ts    one-time: alumni for all history + current crown
  declare.ts     publish label definitions (run after setup)
  dryrun.ts      print parsed history, write nothing
```

## Setup (one time)

You need a **dedicated Bluesky account** for the labeller (don't use a personal
one — it gets a `#atproto_labeler` service endpoint and a subscribe button).

### 1. Create the account & convert it to a labeler

The setup CLI needs the public HTTPS URL where the labeler will be hosted, so
deploy to Railway first (steps below) to get the URL, then run:

```bash
npx @skyware/labeler setup
```

It will prompt for:

- the labeler account's **handle/DID** and **password**
- a **PLC token** — it triggers an email to the account; paste the code back in
- the **endpoint URL** — your Railway public URL, e.g. `https://topchicken-labeler.up.railway.app`

It generates a **secp256k1 signing key** and prints it **once**. Save it — it goes
in `SIGNING_KEY`. This step writes the labeler service endpoint + signing key into
the account's DID document.

### 2. Declare the label definitions

```bash
BSKY_IDENTIFIER=<labeler-handle> BSKY_APP_PASSWORD=<app-password> npm run declare
```

Re-run this whenever `src/labelDefs.ts` changes (it overwrites in place).

### 3. Backfill the history (once, after deploy + volume exist)

Run against the production volume so the backfilled labels land in the live DB.
Either run it as a one-off Railway command, or locally with `DB_PATH` pointed at
a copy. It:

- grants `top-chicken-alumni` to all ~22 distinct historical holders
- grants `top-chicken` to the current holder
- seeds `state.json` so the poller continues seamlessly

```bash
LABELER_DID=<did> SIGNING_KEY=<key> \
BSKY_IDENTIFIER=<handle> BSKY_APP_PASSWORD=<pw> \
npm run backfill
```

## Environment variables

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LABELER_DID` | yes | — | DID of the labeler account |
| `SIGNING_KEY` | yes | — | secp256k1 private key (hex) from `setup` |
| `BSKY_IDENTIFIER` | recommended | — | account used to read feeds (avoids public-API blocking) |
| `BSKY_APP_PASSWORD` | recommended | — | app password for the read account |
| `PDS_URL` | no | `https://bsky.social` | PDS for login |
| `PORT` | no | `4100` | set automatically by Railway |
| `POLL_INTERVAL_MS` | no | `300000` | how often to check the bot feed (5 min) |
| `DB_PATH` | no | `$RAILWAY_VOLUME_MOUNT_PATH/labels.db` | label store path |
| `STATE_PATH` | no | `$RAILWAY_VOLUME_MOUNT_PATH/state.json` | holder state path |

## Railway deploy

1. New project → deploy this repo (Dockerfile builder; `railway.json` pins single
   replica + healthcheck on `/xrpc/_health`).
2. Add a **Volume** mounted at e.g. `/data` (Railway sets
   `RAILWAY_VOLUME_MOUNT_PATH`, which the config reads automatically).
3. Set the env vars above (`LABELER_DID`, `SIGNING_KEY`, `BSKY_IDENTIFIER`,
   `BSKY_APP_PASSWORD`).
4. Deploy → grab the public URL → run `npx @skyware/labeler setup` with that URL.
5. Run `npm run declare`, then `npm run backfill` once.

## Local dev

```bash
npm install
npm run build
# read-only check of the parsed history (writes nothing):
BSKY_IDENTIFIER=... BSKY_APP_PASSWORD=... npm run dev   # or: npx tsx src/dryrun.ts
```
