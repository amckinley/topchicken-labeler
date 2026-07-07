# Top Chicken Labeller 🐔

A Bluesky labeller that badges the reigning **Top Chicken**, the all-time record
holder (**TipTop Chicken**), every account that's ever held the crown, the
specific winning posts, and every post **currently in the running** for the next
crown. It also maintains a **Top Chickens starter pack**.

It does **not** compute the crown itself — the crown labels mirror the canonical
[@topchicken.bsky.social](https://bsky.app/profile/topchicken.bsky.social) feed
and turn it into subscribable labels. The one exception is `top-chicken-eligible`,
which is computed from our approximation of the meme rules (see Labels below).

Subscribe: [topchicken-labeler.bsky.social](https://bsky.app/profile/topchicken-labeler.bsky.social)
· Starter pack: [Top Chickens 🐔](https://bsky.app/starter-pack/topchicken-labeler.bsky.social/3moynae7xhi2e)

## What's a Top Chicken?

A Bluesky meme. Each day, one account earns the crown: the account under the
**7,000-follower "Grace Limit"** whose post got the most likes. Each daily
crowning judges posts with a "36 hour look back, 12 hour outcome" (per dave's
description of his script): a crowning at time T judges posts created in
`[T−36h, T−12h]` — the 12h delay lets likes settle before the outcome is
called. The candidate pool is [@dave.9000ish.uk](https://bsky.app/profile/dave.9000ish.uk)'s
following + followers (~750 accounts). It started from Grace
([@gracekind.net](https://bsky.app/profile/gracekind.net)) saying "gm top
chickens" in 2024.

The crown is announced publicly by two accounts in sequence, which post
`🐔 New Top Chicken! @handle's post got N likes.` with the winner's DID embedded
as a mention facet and the winning post quote-embedded:

| Tracker | Window |
| --- | --- |
| [@dave.9000ish.uk](https://bsky.app/profile/dave.9000ish.uk) | 2026-05-08 → 2026-06-06 |
| [@topchicken.bsky.social](https://bsky.app/profile/topchicken.bsky.social) | 2026-06-06 → present |

## Labels

Each account carries **exactly one** account-level label, by priority:
`tiptop-chicken` > `top-chicken` > `top-chicken-alumni`. So the record holder
shows only 👑, the current daily holder only 🐔, and every other past holder the
alum badge. All at severity `inform` (neutral badge, no blur).

| Value | Name | Subject | Meaning |
| --- | --- | --- | --- |
| `top-chicken` | Top Chicken 🐔 | account DID | current daily holder (moves daily) |
| `tiptop-chicken` | TipTop Chicken 👑 | account DID | highest all-time score ever (moves only when the record is broken) |
| `top-chicken-alumni` | Top Chicken Alum | account DID | has held the crown before (and isn't currently 🐔/👑) |
| `top-chicken-post` | Top Chicken Post 🥇 | post URI | the specific post that won a daily crown |
| `top-chicken-eligible` | Top Chicken Eligible 🐣 | post URI | currently eligible to win — unjudged top-level post by an under-limit pool account (transient) |

DIDs (not handles) are the identity key throughout, pulled from the announcement
mention facets — self-healing across handle renames (e.g. `codetard.bsky.social`
→ `vibe-coded.com` is one DID, one alumnus).

`top-chicken-eligible` is the odd one out: it's **computed, not mirrored**, from
our approximation of the rules — a top-level post (no replies; reposts skipped;
quote posts count) with `createdAt > last crowning − 12h` (not yet judged),
floored at `now − 36h`, by a pool account under the Grace Limit at sweep time.
It's asserted while the post is in the running and negated once a crowning has
judged it, so expect roughly 500–800 live at any moment and edge-case divergence
from whatever dave's script actually does. Design history:
`docs/plans/2026-07-07-eligible-post-labels.md`.

## Architecture

Built on the off-the-shelf **[bsky-watch/labeler](https://github.com/bsky-watch/labeler)**
(vendored in `vendor-labeler/`). It signs labels with
[indigo](https://github.com/bluesky-social/indigo) — the same library the Bluesky
AppView ingester (Vortex) verifies with — so signatures match by construction.
The only logic we own is a small Python poller.

One Railway service, single replica, two processes (see `entrypoint.sh`):

1. **bsky-watch labeler** (`vendor-labeler/`, Go) — serves
   `com.atproto.label.queryLabels` + `subscribeLabels` on `$PORT`, persists to
   SQLite on the volume, publishes/refreshes the label definitions at startup,
   and exposes a localhost-only `POST /label` admin API.
2. **`poller.py`** — two reconcile loops in one process:
   - **Crown mirror** (every `POLL_INTERVAL_S`, default 5 min): reads the
     announcer feeds, derives current / record / alumni / winning posts, POSTs
     labels to the admin API. Idempotent — it re-asserts the full desired state
     each cycle (re-POSTing an unchanged label is a no-op). Also keeps the
     starter pack synced.
   - **Eligible sweep** (every `ELIGIBLE_SWEEP_INTERVAL_S`, default 20 min):
     pages the pool graph (~700 AppView requests/sweep, hence the slower
     cadence), asserts `top-chicken-eligible` on unjudged posts, and negates
     labels on posts a crowning has judged. Negation needs to know what was
     previously asserted, so this loop keeps a state file on the volume
     (`ELIGIBLE_STATE_PATH`, `{uri: {cid, did}}`). A per-sweep **heal pass**
     also re-negates every pool post in the 24h before the eligibility cutoff —
     a no-op for never-labeled posts — so labels stranded by a lost state file
     or a past bug self-clean within one sweep.

State lives on the Railway **volume** (`DB_PATH`, default
`$RAILWAY_VOLUME_MOUNT_PATH/bw-labels.sqlite`). **Single replica is required** —
Railway volumes can't attach to multiple replicas, and a labeller needs one
writer / one cursor sequence anyway.

## Source layout

```
poller.py             our logic: crown mirror + eligible sweep → POST labels + sync pack
starterpack.py        keep the "Top Chickens" starter pack in sync with alumni
config.template.yaml  labeler config, env-substituted at container start
entrypoint.sh         render config, run labeler + poller in one container
Dockerfile            build the Go labeler (Go 1.23) + Python runtime
railway.json          single replica, healthcheck on queryLabels
docs/plans/           design docs (dated; treat as source of truth for the why)
vendor-labeler/       bsky-watch/labeler, vendored (upstream bf2d37a, +1 patch)
```

The one local change to upstream is in `vendor-labeler/server/subscribe.go`:
WebSocket compression is disabled (see the gotcha below).

## Environment variables

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LABELER_DID` | yes | — | DID of the labeler account |
| `SIGNING_KEY` | yes | — | secp256k1 private key (hex), in the DID doc as `#atproto_label` |
| `BSKY_IDENTIFIER` | yes | — | labeler account handle (login for feed reads + record writes) |
| `BSKY_APP_PASSWORD` | yes | — | labeler account app password |
| `LABELER_ENDPOINT` | yes | — | public HTTPS URL of this service |
| `PDS_URL` | no | `https://bsky.social` | PDS for login |
| `PORT` | no | `8080` | public listener; set by Railway |
| `ADMIN_PORT` | no | `8081` | localhost-only `POST /label` |
| `POLL_INTERVAL_S` | no | `300` | how often to poll the feed (seconds) |
| `DB_PATH` | no | `$RAILWAY_VOLUME_MOUNT_PATH/bw-labels.sqlite` | SQLite label store |
| `STARTER_PACK` | no | `1` | sync the Top Chickens starter pack (`0` to disable) |
| `ELIGIBLE_POSTS` | no | `1` | enable the eligible-post sweep (`0` to disable) |
| `ELIGIBLE_SWEEP_INTERVAL_S` | no | `1200` | sweep cadence (seconds) |
| `POOL_ACTOR` | no | `dave.9000ish.uk` | account whose graph defines the candidate pool |
| `ELIGIBLE_STATE_PATH` | no | `$RAILWAY_VOLUME_MOUNT_PATH/eligible-posts.json` | asserted-URIs state file for eligible-post sweep |

The signing key and app password live only in Railway env vars — never committed.
The config template is rendered at container start (`config.yaml` is gitignored).

## Deploy (Railway)

The labeler account (`topchicken-labeler.bsky.social`) is already converted: its
DID doc carries the `#atproto_labeler` service endpoint + `#atproto_label` signing
key, so no PLC changes are needed for normal deploys. Pushes to `main`
auto-deploy via the GitHub integration.

To stand up from scratch (or on a fresh account):

1. Create a dedicated Bluesky account; deploy this repo to Railway (Dockerfile
   builder) and add a **Volume** (e.g. mounted at `/data`).
2. Set the env vars above. Generate `SIGNING_KEY` with
   `openssl ecparam --name secp256k1 --genkey --noout --outform DER | tail -c +8 | head -c 32 | xxd -p -c 64`.
3. Register the signing key + service endpoint in the account's DID doc
   (`vendor-labeler` ships `update-plc`, or use any labeler-setup tool). The
   labeler publishes its label definitions itself at startup.

The poller backfills all historical alumni + the current state automatically on
first run; there is no separate backfill step.

## Gotcha: negations must carry the same `cid` as the assertion

The bsky-watch admin API matches the entry to negate on **`(src, val, uri, cid)`
exactly** (`vendor-labeler/server/core_logic.go`, `writeLabel`). If a label was
asserted with a `cid` (as all our post-level labels are), a negation POST
without one matches nothing, takes the "nothing to negate" branch, and returns
**200 as if it succeeded** — the label stays served, invisibly stranded.
`queryLabels`' negation-suppression is keyed by `cid` too. Rule: **whatever you
assert with, negate with.** Account-DID labels carry no cid, so both sides are
bare and this never bites; it's specific to post labels. Bit us on day one of
`top-chicken-eligible` (365 stranded labels); the sweep's heal pass now makes
this class of stranding self-correcting.

## Gotcha: labels not showing in the AppView (Railway + WebSockets)

The Bluesky AppView ingests third-party labels via **Vortex**, which opens a
`subscribeLabels` websocket per labeler. bsky-watch enables WebSocket
**permessage-deflate compression** by default — and **Railway's edge proxy breaks
the compressed upgrade for Vortex**, so it connects and disconnects in the same
millisecond, repeatedly, never completing a replay. Labels are correct and served
by `queryLabels`, but never appear on profiles.

Fix (already applied): `EnableCompression: false` +
`EnableWriteCompression(false)` in `vendor-labeler/server/subscribe.go`. A direct
client connects fine either way, so this only shows up against Vortex through
Railway — easy to misdiagnose. Confirm via the `vortex_labels_received_total`
metric for the labeler DID climbing, and labels appearing on profiles with the
`atproto-accept-labelers: <did>` header.

Verify our side independently of the AppView:

```bash
# labeler declared + indexed
curl "https://api.bsky.app/xrpc/app.bsky.labeler.getServices?dids=<LABELER_DID>&detailed=true"
# labels served + signed
curl "https://<host>/xrpc/com.atproto.label.queryLabels?uriPatterns=<subject-did>"
# post-level labels: exact at:// URI only — bsky-watch rejects wildcard
# patterns like at://* or at://did:.../app.bsky.feed.post/* ("unsupported pattern")
curl "https://<host>/xrpc/com.atproto.label.queryLabels?uriPatterns=<at://did/app.bsky.feed.post/rkey>"
```

If those return labels but a profile (with `atproto-accept-labelers`) doesn't, the
gap is AppView ingestion, not this service.

## Local dev

```bash
# build the labeler binary (native)
cd vendor-labeler && go build -o /tmp/labeler ./cmd/labeler

# the poller talks to a running labeler's admin API; ADMIN_URL points at it
BSKY_IDENTIFIER=... BSKY_APP_PASSWORD=... LABELER_DID=... \
  ADMIN_URL=http://127.0.0.1:8081/label python3 poller.py
```
