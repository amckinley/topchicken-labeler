# CLAUDE.md — topchicken-labeler

A Bluesky labeller that mirrors the "Top Chicken" meme crown into two labels.
See `README.md` for the meme rules, architecture, and deploy/setup runbook.

## Push and merge policy

Solo personal repo, no GitHub-triggered CI. **Push freely to `main`** — commits
and pushes don't need per-action confirmation. Production deploys are gated
separately by the Railway trigger (see below), not by pushes here.

## Deploy

Hosted on Railway: single replica + a Volume for the SQLite label store. The
account-conversion + deploy runbook lives in `README.md` ("Setup" / "Railway
deploy"). The secp256k1 `SIGNING_KEY` and the labeler account's app password
live only in Railway env vars — never commit them.

## Data note

The crowning history is mirrored live from the announcer feeds at runtime; there
is no checked-in dataset. The scratch extractor used during initial development
lives outside this repo at `~/src/scratch/topchicken/`.
