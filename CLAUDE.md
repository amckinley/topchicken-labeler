# CLAUDE.md — topchicken-labeler

A Bluesky labeller that mirrors the "Top Chicken" meme crown into labels, built on
the vendored off-the-shelf `bsky-watch/labeler` (Go) plus a small Python poller
(`poller.py`). See `README.md` for the meme rules, label set, architecture, env
vars, deploy, and the Railway-WebSocket-compression gotcha.

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
