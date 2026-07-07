#!/usr/bin/env python3
"""Top Chicken poller.

Reads the canonical crowning announcements (dave.9000ish.uk + topchicken.bsky.social),
derives the label state, and POSTs labels to the local bsky-watch/labeler admin API.
The labeler binary handles all signing / serving / PLC — this is the only logic we own.

Labels (all on account DIDs except top-chicken-post and top-chicken-eligible which are
on post URIs):
  top-chicken           current daily holder        (single; moved by negation)
  top-chicken-alumni    ever held the crown         (sticky)
  tiptop-chicken        all-time record holder      (single; moved by negation)
  top-chicken-post      the specific winning post   (record-level, sticky)
  top-chicken-eligible  currently in the running    (record-level, transient; negated
                        when the post ages out of the 24h window)

The bsky-watch admin API is declarative-ish: POST {uri, val} adds a label, POST
{uri, val, neg:true} negates it. It dedupes (returns 200 vs 201), so re-POSTing a
label already present is a harmless no-op — which makes the poller naturally
idempotent and lets us just re-assert the full desired state each cycle.
"""
import datetime
import json
import os
import re
import tempfile
import time
import urllib.request
import urllib.parse

import starterpack

BOT_HANDLES = ["dave.9000ish.uk", "topchicken.bsky.social"]
APPVIEW = "https://api.bsky.app"
PDS = os.environ.get("PDS_URL", "https://bsky.social")
ADMIN = os.environ.get("ADMIN_URL", "http://127.0.0.1:8081/label")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_S", "300"))
IDENT = os.environ["BSKY_IDENTIFIER"]
PW = os.environ["BSKY_APP_PASSWORD"]
LABELER_DID = os.environ.get("LABELER_DID", "")
# Set STARTER_PACK=1 to keep a "Top Chickens" starter pack synced with the alumni set.
STARTER_PACK = os.environ.get("STARTER_PACK", "1") not in ("", "0", "false")
# Set ELIGIBLE_POSTS=0 to disable the eligible-post sweep.
ELIGIBLE_POSTS = os.environ.get("ELIGIBLE_POSTS", "1") not in ("", "0", "false")
ELIGIBLE_SWEEP_INTERVAL_S = int(os.environ.get("ELIGIBLE_SWEEP_INTERVAL_S", "1200"))
POOL_ACTOR = os.environ.get("POOL_ACTOR", "dave.9000ish.uk")
_vol = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "")
ELIGIBLE_STATE_PATH = os.environ.get(
    "ELIGIBLE_STATE_PATH",
    f"{_vol}/eligible-posts.json" if _vol else "./eligible-posts.json",
)

CROWN_RE = re.compile(r"New Top Chicken!\s*@([\w.\-]+)'s post got ([\d,]+) likes")

L_CURRENT = "top-chicken"
L_ALUMNI = "top-chicken-alumni"
L_RECORD = "tiptop-chicken"
L_POST = "top-chicken-post"
L_ELIGIBLE = "top-chicken-eligible"

GRACE_LIMIT = 7000
ELIGIBLE_WINDOW_S = 86400   # 24h
ELIGIBLE_MAX_PAGES = 20     # safety cap per account


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


def _load_eligible_state():
    """Load previous eligible-post state from disk. Returns {} on missing/corrupt file."""
    try:
        with open(ELIGIBLE_STATE_PATH, "r") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        raise ValueError("state file is not a JSON object")
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError, ValueError) as e:
        # Raise so the sweep aborts and does NOT overwrite the file with an
        # empty previous set, which would permanently strand aged-out labels.
        raise RuntimeError(f"eligible state unreadable: {e}") from e


def _save_eligible_state(state):
    """Write eligible-post state atomically via a temp file in the same directory."""
    path = ELIGIBLE_STATE_PATH
    dir_ = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=dir_, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _get_pool_dids():
    """Union of followers and follows of POOL_ACTOR (unauthenticated)."""
    dids = set()
    for rel in ("getFollowers", "getFollows"):
        cursor = None
        for _ in range(200):
            qs = {"actor": POOL_ACTOR, "limit": "100"}
            if cursor:
                qs["cursor"] = cursor
            d, _ = _req(f"{APPVIEW}/xrpc/app.bsky.graph.{rel}?" + urllib.parse.urlencode(qs))
            key = "followers" if rel == "getFollowers" else "follows"
            for acct in d.get(key, []):
                if acct.get("did"):
                    dids.add(acct["did"])
            cursor = d.get("cursor")
            if not cursor:
                break
    return dids


def _filter_under_limit(dids):
    """Return (eligible, unknown) where eligible has followersCount < GRACE_LIMIT.

    unknown contains DIDs whose batch lookup failed or whose followersCount was
    missing/non-int — callers should carry over their previously-asserted labels
    rather than negating them on a flaky cycle. Batches of 25.
    """
    dids = list(dids)
    eligible = set()
    unknown = set()
    for i in range(0, len(dids), 25):
        batch = dids[i:i+25]
        qs = urllib.parse.urlencode([("actors", d) for d in batch])
        try:
            d, _ = _req(f"{APPVIEW}/xrpc/app.bsky.actor.getProfiles?{qs}")
        except Exception as e:
            print(f"  ! getProfiles batch error: {e}", flush=True)
            # Fail closed: without follower counts we can't prove eligibility.
            # Track as unknown so the caller preserves previous labels rather
            # than mass-negating on a transient error.
            unknown.update(batch)
            continue
        for profile in d.get("profiles", []):
            did = profile.get("did")
            if not did:
                continue
            followers_count = profile.get("followersCount")
            if isinstance(followers_count, int):
                if followers_count < GRACE_LIMIT:
                    eligible.add(did)
                # else: known over-limit — neither eligible nor unknown, so its
                # previous labels land in to_negate and get negated correctly.
            else:
                # Missing/non-int count: can't prove eligibility either way.
                unknown.add(did)
    return eligible, unknown


def _eligible_posts_for_did(did, cutoff_ts):
    """Fetch top-level posts (no reply, no repost) within cutoff_ts for a single DID.

    Returns list of {uri, cid} dicts, or raises on failure.
    Stops paging once all posts on a page are older than the cutoff.
    """
    posts = []
    cursor = None
    for _ in range(ELIGIBLE_MAX_PAGES):
        qs = {"actor": did, "limit": "100", "filter": "posts_with_replies"}
        if cursor:
            qs["cursor"] = cursor
        d, _ = _req(f"{APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?" + urllib.parse.urlencode(qs))
        feed = d.get("feed", [])
        for item in feed:
            # Skip reposts (reason present on the feed item).
            if item.get("reason"):
                continue
            post = item.get("post", {})
            rec = post.get("record", {})
            # Skip replies.
            if rec.get("reply"):
                continue
            created_at = rec.get("createdAt", "")
            if created_at >= cutoff_ts:
                uri = post.get("uri")
                cid = post.get("cid")
                if uri and cid:
                    posts.append({"uri": uri, "cid": cid})
        # Stop paging when all non-repost items on this page are older than the
        # cutoff — reverse-chronological ordering guarantees later pages are older.
        non_repost = [it for it in feed if not it.get("reason")]
        if non_repost and all(
            (it.get("post", {}).get("record", {}).get("createdAt", "") or "") < cutoff_ts
            for it in non_repost
        ):
            break
        cursor = d.get("cursor")
        if not cursor or not feed:
            break
    return posts


def eligible_sweep():
    """Assert top-chicken-eligible on all in-window top-level posts from pool accounts.

    Returns (pool_size, eligible_accounts, posts_labeled, negated, new_labels, skipped).
    """
    cutoff_dt = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=ELIGIBLE_WINDOW_S)
    # ISO 8601 string for lexicographic comparison with createdAt values.
    cutoff_ts = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%S")

    previous = _load_eligible_state()  # {uri: {cid, did}}

    pool = _get_pool_dids()
    eligible_dids, unknown_dids = _filter_under_limit(pool)

    desired = {}   # {uri: {cid, did}}
    skipped = 0
    for did in eligible_dids:
        try:
            posts = _eligible_posts_for_did(did, cutoff_ts)
            for p in posts:
                desired[p["uri"]] = {"cid": p["cid"], "did": did}
        except Exception as e:
            print(f"  ! eligible fetch failed {did[:20]}: {e}", flush=True)
            skipped += 1
            # Carry over previously-asserted URIs for this account so a flaky cycle
            # doesn't mass-negate good labels.
            for uri, info in previous.items():
                if info.get("did") == did:
                    desired[uri] = info

    # Carry over previous labels for accounts whose profile batch failed — we
    # can't prove they're over the limit so we don't negate them this cycle.
    for uri, info in previous.items():
        if info.get("did") in unknown_dids:
            desired[uri] = info

    # Negations: URIs in previous but not in desired.
    to_negate = set(previous) - set(desired)
    failed_negate = set()
    for uri in to_negate:
        if add_label(uri, L_ELIGIBLE, neg=True) is None:
            # POST failed — keep in state so we retry next sweep.
            failed_negate.add(uri)

    # Assertions: everything in desired (idempotent).
    new_labels = 0
    for uri, info in desired.items():
        result = add_label(uri, L_ELIGIBLE, cid=info["cid"])
        if result == 201:
            new_labels += 1

    # New state = desired + any URIs whose negation failed.
    next_state = dict(desired)
    for uri in failed_negate:
        next_state[uri] = previous[uri]
    _save_eligible_state(next_state)

    negated = len(to_negate) - len(failed_negate)
    return len(pool), len(eligible_dids), len(desired), negated, new_labels, skipped


def main():
    print(f"top chicken poller starting; admin={ADMIN} interval={POLL_INTERVAL}s", flush=True)
    last_eligible_sweep = 0.0
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
                # Keep the starter pack in sync (creates it once, appends new
                # winners as they're crowned). Failures here never block labeling.
                if STARTER_PACK and LABELER_DID:
                    try:
                        added = starterpack.sync(LABELER_DID, IDENT, PW, sorted(state["alumni"]))
                        if added:
                            print(f"starter pack: added {added} member(s)", flush=True)
                    except Exception as e:
                        print(f"starter pack sync error: {e}", flush=True)
        except Exception as e:
            print(f"poll error: {e}", flush=True)
        # Eligible-post sweep runs on its own slower cadence, independently of the
        # crown mirror above.
        if ELIGIBLE_POSTS and time.monotonic() - last_eligible_sweep >= ELIGIBLE_SWEEP_INTERVAL_S:
            try:
                pool_sz, elig_accts, posts_lbl, negated, new_lbl, skipped = eligible_sweep()
                print(
                    f"eligible sweep: pool={pool_sz} eligible_accounts={elig_accts} "
                    f"posts={posts_lbl} negated={negated} new={new_lbl} skipped={skipped}",
                    flush=True,
                )
                last_eligible_sweep = time.monotonic()
            except Exception as e:
                print(f"eligible sweep error: {e}", flush=True)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
