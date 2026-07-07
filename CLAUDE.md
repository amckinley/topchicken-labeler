# CLAUDE.md — topchicken-labeler

A Bluesky labeller for the "Top Chicken" meme, built on the vendored
off-the-shelf `bsky-watch/labeler` (Go) plus a Python poller (`poller.py`) with
two loops: a crown **mirror** (announcer feeds → crown/alumni/record labels) and
a computed **eligible sweep** (`top-chicken-eligible` on unjudged posts, with a
state file on the volume for negation bookkeeping). See `README.md` for the meme
rules, label set, architecture, env vars, deploy, and the two gotchas
(cid-matched negations; Railway WebSocket compression). Design docs live in
`docs/plans/` — update them in the same commit when implementation diverges.

## Push and merge policy

Solo personal repo, no GitHub-triggered CI. **Push freely to `main`** — commits
and pushes don't need per-action confirmation. Production deploys are gated
separately by the Railway trigger (see below), not by pushes here.

## Deploy

Hosted on Railway: single replica + a Volume for the SQLite label store. One
container runs the bsky-watch labeler binary + the poller (`entrypoint.sh`). The
deploy runbook + env vars live in `README.md`. The secp256k1 `SIGNING_KEY` and the
labeler account's app password live only in Railway env vars — never commit them.

## Data note

The crowning history is mirrored live from the announcer feeds at runtime; there
is no checked-in dataset. The scratch extractor used during initial development
lives outside this repo at `~/src/scratch/topchicken/`.
