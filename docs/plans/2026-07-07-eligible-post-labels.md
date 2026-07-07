# Eligible-post labels (`top-chicken-eligible`)

2026-07-07. Status: **shipped** (same day, three commits: initial 24h-window
version → corrected eligibility window per dave → cid-negation fix + heal
pass). Updated post-ship to match what runs in production.

## Goal

Today the labeler only mirrors *outcomes* (crownings). Add a record-level label
on every post that is **currently eligible to win** Top Chicken: an unjudged
top-level post by an account in the candidate pool that is under
the 7,000-follower Grace Limit. Users who find it noisy can hide the badge
per-label in app settings; that's why we're doing the full version rather than
a front-runner-only label.

This is the first label we *compute* rather than mirror. The eligibility rules
are approximated from the announcer's behavior, not from dave's actual script;
"eligible" is a soft claim and small divergences are acceptable.

## Rules (as we implement them)

- **Pool**: followers ∪ follows of `POOL_ACTOR` (default `dave.9000ish.uk`),
  fetched live each sweep. DIDs are the identity key, as everywhere else.
- **Grace Limit**: author has `followersCount < 7000` at sweep time
  (`app.bsky.actor.getProfiles`, batches of 25).
- **Post window**: per dave (DM, 2026-07-07): "36 hour look back. 12 hour
  outcome." A crowning at time T judges posts created in `[T−36h, T−12h]`.
  So a post is eligible iff `createdAt > last_crowning − 12h` (not yet judged),
  floored at `now − 36h` (older than a full lookback can never win, even if
  the announcer stalls). The original 24h-window guess shipped first and was
  corrected same-day.
- **Top-level posts only**: no replies (records with a `reply` field are out),
  no reposts (feed items with a `reason` are out). Quote posts count.
- A post that won the crown keeps its transient `top-chicken-eligible` label
  until it ages out naturally; the overlap with `top-chicken-post` is harmless.

## Numbers (measured 2026-07-07)

- Pool: 754 accounts (634 followers + 252 follows, union).
- 91 over the Grace Limit → 663 eligible accounts.
- 816 top-level posts in the trailing 24h (2,338 with replies — excluded).
- Expected churn: ~800 label adds + ~800 negations/day. Trivial for the SQLite
  store and label stream (~600k rows/year worst case).

## Approach

### Label definition

Add `top-chicken-eligible` to `config.template.yaml` (severity `inform`,
blurs `none`, defaultsetting `warn`, adultonly false), matching the existing
entries. Suggested copy:

- name: `Top Chicken Eligible 🐣`
- description: "This post is currently in the running for Top Chicken: posted
  in the last 24 hours by an account under the 7,000-follower Grace Limit."

The labeler publishes definitions at startup; no other declare step.

### Sweep (new, in `poller.py`)

A new `eligible_sweep()` that runs on its own cadence inside the existing
single-threaded main loop (track `last_sweep` timestamp; no threads):

1. Page `getFollowers` + `getFollows` for `POOL_ACTOR` → pool DIDs.
2. Batch `getProfiles` → drop DIDs at/over 7,000 followers.
3. For each eligible DID, page `getAuthorFeed`
   (`filter=posts_with_replies`, then filter top-level ourselves — we need the
   `reason`/`reply` distinction anyway) until the page's own posts are all
   older than the 24h cutoff. Collect `(uri, cid)` of in-window top-level posts.
4. Compute `desired` set of URIs. Load `previous` from the state file.
   Negate `previous − desired`; assert every member of `desired` (idempotent,
   same `add_label` path, include `cid`). Write state file = `desired` ∪
   (any URIs whose negation POST failed, so they're retried next sweep).
5. **Heal pass** (added after the cid-negation bug, see Postscript): negate
   (with cid) every pool post created in `[cutoff − 24h, cutoff)` that isn't
   in `desired`. Negating a never-labeled post is a server-side no-op, so this
   runs every sweep. Since eligible labels are only ever asserted on posts
   newer than the cutoff, any stranded label is caught here within one sweep
   of the cutoff moving past it — regardless of state-file integrity.

**Negations must carry the same `cid` as the assertion** — the bsky-watch
`writeLabel` matches on `(src, val, uri, cid)` exactly and returns a
success-looking 200 no-op when nothing matches. See README gotcha.

### State file

The poller gains persistent state for the first time: a JSON file on the
volume (`ELIGIBLE_STATE_PATH`, default
`$RAILWAY_VOLUME_MOUNT_PATH/eligible-posts.json`) holding the URIs currently
labeled. Needed because negation requires knowing what we asserted last sweep,
and it must survive restarts (an in-memory set would strand stale labels after
every deploy). Write atomically (temp file + rename). A missing file (first run) means `previous` = empty; a corrupt or
unreadable file aborts the sweep rather than overwriting the file. The heal
pass (above) has since demoted state-file loss from "labels stranded forever,
manual queryLabels reconstruction" to "cleaned automatically within one sweep"
— the file now mainly serves the fast path and the carry-over-on-flaky-fetch
protections.

### Cadence and rate limiting

A full sweep is ~700 AppView requests. Run it every
`ELIGIBLE_SWEEP_INTERVAL_S` (default **1200s / 20 min**), separate from the
5-minute crown mirror — likes ebb slowly and the label claims "eligible," not
"winning," so 20-minute staleness at the edges is fine. Fetch author feeds
with bounded concurrency (≤8 workers) or serially with no sleep — either keeps
sustained load under ~1 req/s. Unauthenticated `api.bsky.app` calls (public
data; no token needed for the sweep).

Per-account failures (deactivated, network) must not abort the sweep: skip the
account, keep its previously-asserted URIs in the state file so nothing gets
mass-negated on a flaky cycle, and log a summary count.

### Env vars (additions to README table)

| Var | Default | Purpose |
| --- | --- | --- |
| `ELIGIBLE_POSTS` | `1` | enable the eligible-post sweep (`0` to disable) |
| `ELIGIBLE_SWEEP_INTERVAL_S` | `1200` | sweep cadence (seconds) |
| `POOL_ACTOR` | `dave.9000ish.uk` | account whose graph defines the pool |
| `ELIGIBLE_STATE_PATH` | `$RAILWAY_VOLUME_MOUNT_PATH/eligible-posts.json` | asserted-URIs state file |

## Phasing

Single PR/commit: label definition + sweep + README updates ship together.
First deploy asserts ~800 labels in one sweep (a few minutes of POSTs to the
admin API); no separate backfill step, matching the existing pattern.

## Open questions

- Whether dave's script counts quote posts or checks the follower limit at a
  different moment than we do. Accepted as approximation; a divergence
  mislabels edge cases only.
- Whether the pool should ever switch to the tracker account's graph if the
  meme migrates again — that's what `POOL_ACTOR` is for.

## Out of scope

- Replies (explicitly excluded by operator decision, 2026-07-07).
- A front-runner/contender label (may revisit; this doc's sweep collects
  `likeCount`-free data, a contender label would need likes too).
- Computing or predicting the crown itself; the mirror remains canonical.
- Retroactively labeling historical eligible posts.

## Postscript: what changed between plan and production (all 2026-07-07)

1. **Eligibility window corrected.** Planned as trailing-24h; dave's actual
   rule (via DM) is "36 hour look back, 12 hour outcome," i.e. eligible ⇔ not
   yet judged: `createdAt > last_crowning − 12h`, floored at `now − 36h`. The
   crown mirror now feeds its latest crowning timestamp to the sweep. Steady
   state is ~500–800 live labels, not the ~800/day-window figure above.
2. **cid-negation bug.** First production sweep "negated" 365 stale labels as
   silent 200 no-ops (assert carried cid, negate didn't; `writeLabel` matches
   on the full tuple) and dropped them from state — stranded. Fix: negate with
   the stored cid, plus the heal pass, which cleaned all 365 on its first
   sweep (verified via a sentinel post disappearing from `queryLabels`).
3. Verified end-to-end against a local labeler binary + scratch SQLite:
   negate-without-cid leaves the label served; negate-with-cid suppresses it.
