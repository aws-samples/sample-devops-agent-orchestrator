#!/usr/bin/env python3
"""
CollectAccount worker (webapp task 26.1) — the per-item compute of the refresh
Distributed Map.

The refresh state machine's Distributed Map reads the account list from S3 and
invokes this Lambda once per account with the map item as the event. The handler
collects exactly that one account (assume collector role -> collect all spaces ->
write per-account raw shards + `raw/account=<id>/_account.json`) by delegating to
`collect_account()` in `03_collect.py`, so the collection logic has a single
source of truth shared with the local `10_refresh_all.py` pipeline.

Per-account isolation (Requirement 10.10): `collect_account` never raises — it
records any failure in the returned entry's `error` field and still writes
`_account.json`. This handler therefore returns a small result for every account
(success or failure) so a single bad account does not fail the whole map; the
map's tolerated-failure policy plus this result let assembly see every account.
"""
import importlib.util
import os

# Load 03_collect.py by path (module name starts with a digit, so it cannot be
# imported with a normal `import` statement).
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("collect_module", os.path.join(_HERE, "03_collect.py"))
_collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_collect)


def _account_id(event):
    """Extract the account id from a Distributed Map item (tolerant of key case)."""
    if not isinstance(event, dict):
        raise ValueError(f"Unexpected map item type: {type(event).__name__}")
    for key in ("id", "account", "accountId", "Id", "Account"):
        val = event.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    raise ValueError(f"Map item missing an account id: {sorted(event.keys())}")


def _account_name(event):
    for key in ("name", "Name", "accountName"):
        val = event.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def handler(event, _context=None):
    """Collect one account. Returns a compact, JSON-serialisable result."""
    account_id = _account_id(event)
    name = _account_name(event)
    entry = _collect.collect_account(account_id, name)
    return {
        "account": account_id,
        "name": name,
        "spaceCount": len(entry.get("spaces", [])),
        "error": entry.get("error"),
        "ok": entry.get("error") is None,
    }
