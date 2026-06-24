#!/usr/bin/env python3
"""Top Chicken poller.

Reads the canonical crowning announcements (dave.9000ish.uk + topchicken.bsky.social),
derives the label state, and POSTs labels to the local bsky-watch/labeler admin API.
The labeler binary handles all signing / serving / PLC — this is the only logic we own.

Labels (all on account DIDs except top-chicken-post which is on the winning post URI):
  top-chicken         current daily holder        (single; moved by negation)
  top-chicken-alumni  ever held the crown         (sticky)
  tiptop-chicken      all-time record holder      (single; moved by negation)
  top-chicken-post    the specific winning post   (record-level)

The bsky-watch admin API is declarative-ish: POST {uri, val} adds a label, POST
{uri, val, neg:true} negates it. It dedupes (returns 200 vs 201), so re-POSTing a
label already present is a harmless no-op — which makes the poller naturally
idempotent and lets us just re-assert the full desired state each cycle.
"""
import json
import os
import re
import time
import urllib.request
import urllib.parse

BOT_HANDLES = ["dave.9000ish.uk", "topchicken.bsky.social"]
APPVIEW = "https://api.bsky.app"
PDS = os.environ.get("PDS_URL", "https://bsky.social")
ADMIN = os.environ.get("ADMIN_URL", "http://127.0.0.1:8081/label")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_S", "300"))
IDENT = os.environ["BSKY_IDENTIFIER"]
PW = os.environ["BSKY_APP_PASSWORD"]

CROWN_RE = re.compile(r"New Top Chicken!\s*@([\w.\-]+)'s post got ([\d,]+) likes")

L_CURRENT = "top-chicken"
L_ALUMNI = "top-chicken-alumni"
L_RECORD = "tiptop-chicken"
L_POST = "top-chicken-post"


def _req(url, token=None, method="GET", body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "{}", strict=False), r.status


def login():
    d, _ = _req(f"{PDS}/xrpc/com.atproto.server.createSession", method="POST",
                body={"identifier": IDENT, "password": PW})
    return d["accessJwt"]


def author_feed(token, actor):
    out, cursor = [], None
    for _ in range(80):
        qs = {"actor": actor, "limit": "100", "filter": "posts_with_replies"}
        if cursor:
            qs["cursor"] = cursor
        d, _ = _req(f"{APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?" + urllib.parse.urlencode(qs), token)
        feed = d.get("feed", [])
        out.extend(feed)
        cursor = d.get("cursor")
        if not cursor or not feed:
            break
    return out


def winner_did(record, handle):
    """DID from the mention facet matching @handle; fall back to first mention."""
    text = record.get("text", "")
    tb = text.encode("utf-8")
    target = f"@{handle}"
    first = None
    for facet in record.get("facets", []):
        idx = facet.get("index", {})
        seg = tb[idx.get("byteStart", 0):idx.get("byteEnd", 0)].decode("utf-8", "ignore")
        for feat in facet.get("features", []):
            if "mention" not in feat.get("$type", ""):
                continue
            if first is None:
                first = feat.get("did")
            if seg == target:
                return feat.get("did")
    return first


def winning_post(record):
    """(uri, cid) of the quote-embedded winning post, if present."""
    emb = record.get("embed", {})
    if emb.get("$type") == "app.bsky.embed.record":
        rec = emb.get("record", {})
        if rec.get("uri"):
            return rec.get("uri"), rec.get("cid")
    return None, None


def build_state(token):
    """Parse all crownings -> (current, alumni:set, record, winning_posts:list)."""
    crownings = []  # (ts, did, likes, post_uri, post_cid)
    for actor in BOT_HANDLES:
        for it in author_feed(token, actor):
            rec = it.get("post", {}).get("record", {})
            m = CROWN_RE.search(rec.get("text", ""))
            if not m:
                continue
            did = winner_did(rec, m.group(1))
            if not did:
                continue
            ts = (rec.get("createdAt") or "")[:19]
            likes = int(m.group(2).replace(",", ""))
            puri, pcid = winning_post(rec)
            crownings.append((ts, did, likes, puri, pcid))

    # Dedupe identical crownings across the handover, sort chronological.
    seen, deduped = set(), []
    for c in sorted(crownings):
        key = (c[0][:10], c[1], c[2])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(c)

    if not deduped:
        return None

    alumni = {c[1] for c in deduped}
    current = deduped[-1][1]
    record_did, record_likes = None, -1
    for _, did, likes, _, _ in deduped:
        if likes > record_likes:
            record_did, record_likes = did, likes
    winning_posts = [(c[3], c[4]) for c in deduped if c[3]]
    return {
        "current": current,
        "alumni": alumni,
        "record": record_did,
        "winning_posts": winning_posts,
        "all_dids": alumni,
    }


def add_label(uri, val, neg=False, cid=None):
    # The bsky-watch admin API returns a plain-text body ("OK"), not JSON, so we
    # read only the status code (201 = newly created, 200 = already present/no-op).
    body = {"uri": uri, "val": val}
    if neg:
        body["neg"] = True
    if cid:
        body["cid"] = cid
    try:
        req = urllib.request.Request(
            ADMIN, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except Exception as e:
        print(f"  ! label failed {val} {uri[:30]}: {e}", flush=True)
        return None


ACCOUNT_LABELS = (L_RECORD, L_CURRENT, L_ALUMNI)


def desired_account_label(did, state):
    """The single account-level label a DID should carry, by priority:
    tiptop-chicken (all-time record) > top-chicken (current daily) > top-chicken-alumni.
    One badge per account: the record holder shows only 👑, the current holder only 🐔,
    everyone else who's ever held it shows the alum badge."""
    if did == state["record"]:
        return L_RECORD
    if did == state["current"]:
        return L_CURRENT
    return L_ALUMNI


def reconcile(state):
    """Assert the full desired label state. Each account carries exactly one
    account-level label (highest priority); the other two are negated. Idempotent —
    re-POSTing an unchanged label is a no-op."""
    n_new = 0
    # Account labels: one per account, negate the rest.
    for did in state["alumni"]:
        want = desired_account_label(did, state)
        if add_label(did, want) == 201:
            n_new += 1
        for other in ACCOUNT_LABELS:
            if other != want:
                add_label(did, other, neg=True)
    # Winning posts: record-level, sticky, independent of account labels.
    for uri, cid in state["winning_posts"]:
        if add_label(uri, L_POST, cid=cid) == 201:
            n_new += 1
    return n_new


def main():
    print(f"top chicken poller starting; admin={ADMIN} interval={POLL_INTERVAL}s", flush=True)
    while True:
        try:
            token = login()
            state = build_state(token)
            if not state:
                print("no crownings found", flush=True)
            else:
                new = reconcile(state)
                print(f"reconciled: current={state['current'][:20]} "
                      f"record={state['record'][:20]} alumni={len(state['alumni'])} "
                      f"posts={len(state['winning_posts'])} new_labels={new}", flush=True)
        except Exception as e:
            print(f"poll error: {e}", flush=True)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
