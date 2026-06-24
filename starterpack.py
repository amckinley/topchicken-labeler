"""Keep a 'Top Chickens' starter pack in sync with the alumni set.

A starter pack is an app.bsky.graph.starterpack record backed by an
app.bsky.graph.list (purpose=referencelist) whose membership is a set of
app.bsky.graph.listitem records. List and starterpack records require TID rkeys
(arbitrary string rkeys are rejected), so we can't use a fixed rkey for
idempotency — instead we discover the existing list/pack by name via listRecords,
create them only if absent, and add a listitem only for DIDs not already in the
list. New Top Chickens are appended automatically as they're crowned.

Writes go to the labeler account's own PDS (resolved from its DID doc), using a
session created with its app password.
"""
import datetime
import json
import urllib.error
import urllib.parse
import urllib.request

LIST_NAME = "Top Chickens 🐔"
LIST_DESC = "Every account that has ever held the Top Chicken crown."
PACK_NAME = "Top Chickens 🐔"
PACK_DESC = ("Everyone who's ever been Top Chicken — the daily most-liked post "
             "from an account under the 7,000-follower Grace Limit. "
             "Tracked by @topchicken-labeler.bsky.social.")


def _post(url, token, body):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "{}", strict=False)


def _get(url, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "{}", strict=False)


def _resolve_pds(did):
    """The account's PDS service endpoint, from its DID doc."""
    doc = _get(f"https://plc.directory/{did}")
    for svc in doc.get("service", []):
        if svc.get("type") == "AtprotoPersonalDataServer":
            return svc["serviceEndpoint"]
    raise RuntimeError(f"no PDS endpoint in DID doc for {did}")


def _post_session(pds, identifier, password):
    req = urllib.request.Request(
        f"{pds}/xrpc/com.atproto.server.createSession",
        data=json.dumps({"identifier": identifier, "password": password}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read(), strict=False)


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _create_record(pds, token, did, collection, record):
    return _post(f"{pds}/xrpc/com.atproto.repo.createRecord", token, {
        "repo": did, "collection": collection, "record": record,
    })


def _list_records(pds, token, did, collection):
    """All records in a collection (uri + value), following pagination."""
    out, cursor = [], None
    for _ in range(50):
        qs = {"repo": did, "collection": collection, "limit": "100"}
        if cursor:
            qs["cursor"] = cursor
        d = _get(f"{pds}/xrpc/com.atproto.repo.listRecords?{urllib.parse.urlencode(qs)}", token)
        out.extend(d.get("records", []))
        cursor = d.get("cursor")
        if not cursor:
            break
    return out


def _find_by_name(records, name):
    """First record whose value.name matches, else None."""
    for rec in records:
        if rec.get("value", {}).get("name") == name:
            return rec
    return None


def sync(did, identifier, password, alumni_dids):
    """Ensure the 'Top Chickens' list, its members (== alumni_dids), and the
    starter pack exist on `did`. Returns count of newly-added members. Idempotent:
    the list/pack are matched by name (rkeys are TIDs, not fixed), and listitems
    are only created for DIDs not already present."""
    pds = _resolve_pds(did)
    token = _post_session(pds, identifier, password)["accessJwt"]

    # 1. List record — find existing by name, else create (TID rkey).
    lists = _list_records(pds, token, did, "app.bsky.graph.list")
    existing_list = _find_by_name(lists, LIST_NAME)
    if existing_list:
        list_uri = existing_list["uri"]
    else:
        res = _create_record(pds, token, did, "app.bsky.graph.list", {
            "$type": "app.bsky.graph.list",
            "purpose": "app.bsky.graph.defs#referencelist",
            "name": LIST_NAME,
            "description": LIST_DESC,
            "createdAt": _now_iso(),
        })
        list_uri = res["uri"]

    # 2. Members: add a listitem for any alumni DID not already in this list.
    members = set()
    for rec in _list_records(pds, token, did, "app.bsky.graph.listitem"):
        v = rec.get("value", {})
        if v.get("list") == list_uri and v.get("subject"):
            members.add(v["subject"])
    added = 0
    for member in alumni_dids:
        if member in members:
            continue
        _create_record(pds, token, did, "app.bsky.graph.listitem", {
            "$type": "app.bsky.graph.listitem",
            "subject": member,
            "list": list_uri,
            "createdAt": _now_iso(),
        })
        added += 1

    # 3. Starter pack referencing the list — find by name, else create.
    packs = _list_records(pds, token, did, "app.bsky.graph.starterpack")
    if not _find_by_name(packs, PACK_NAME):
        _create_record(pds, token, did, "app.bsky.graph.starterpack", {
            "$type": "app.bsky.graph.starterpack",
            "name": PACK_NAME,
            "description": PACK_DESC,
            "list": list_uri,
            "createdAt": _now_iso(),
        })

    return added

    return added
