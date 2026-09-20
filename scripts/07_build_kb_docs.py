#!/usr/bin/env python3
"""
Step 7 - render the collected raw JSON (S3 raw/) into human-readable Markdown
documents (S3 kb/) that the Bedrock managed knowledge base ingests. Raw JSON
chunks poorly for RAG; one readable doc per account + per agent space makes the
chat app far more useful. Also writes a <file>.metadata.json sidecar per doc so
answers can be filtered by account.

Business context (Requirement 5.5)
----------------------------------
When ``hub/business_context.json`` is present it overlays:
  * ``accountDisplayNames`` - the display name becomes the primary
    human-friendly label on each account doc (the raw account id is retained
    for reference), and
  * ``businessUnits`` - one extra doc is emitted per Business_Unit listing its
    member accounts and their agent spaces, so KB chat answers reflect the
    groupings.
Absent or invalid context fails open: docs fall back to raw account ids / org
names and no Business_Unit docs are emitted.

Run with hub credentials (profile 123456789012).
"""
import json
import os
from collections import Counter

from _common import CFG, hub_session

# Fall back to safe defaults so importing this module (e.g. from unit tests)
# never raises when HUB_BUCKET/KB_DOCS_PREFIX are unset; a real run resolves
# them from config.env / the environment. The S3 client below is created lazily.
BUCKET = CFG.get("HUB_BUCKET") or os.getenv("HUB_BUCKET", "unit-test-placeholder-bucket")
DOCS = CFG.get("KB_DOCS_PREFIX") or os.getenv("KB_DOCS_PREFIX", "kb/")

_S3 = None


def s3():
    """Lazily create the hub S3 client so importing this module (e.g. from
    unit tests) never requires AWS credentials or a configured profile."""
    global _S3
    if _S3 is None:
        _S3 = hub_session().client("s3")
    return _S3


def read_json(key, default=None):
    try:
        return json.loads(s3().get_object(Bucket=BUCKET, Key=key)["Body"].read())
    except Exception:
        return default


def put_doc(name, body, account, business_unit=None):
    key = f"{DOCS}{name}"
    s3().put_object(Bucket=BUCKET, Key=key, Body=body.encode(), ContentType="text/markdown")
    attrs = {"account": account, "source": "aws-devops-agent"}
    if business_unit:
        attrs["businessUnit"] = business_unit
    meta = {"metadataAttributes": attrs}
    s3().put_object(Bucket=BUCKET, Key=key + ".metadata.json",
                    Body=json.dumps(meta).encode(), ContentType="application/json")


def assoc_target(cfg):
    for kind, val in (cfg or {}).items():
        if isinstance(val, dict) and val:
            ref = (val.get("accountId") or val.get("repoName") or val.get("owner")
                   or val.get("projectPath") or val.get("envId") or val.get("workspaceName")
                   or val.get("organizationName") or val.get("endpoint") or "")
            return kind, ref
    return "unknown", ""


# --------------------------------------------------------------------------- #
# Business context (Requirement 5.5) - pure helpers, no AWS I/O.              #
# --------------------------------------------------------------------------- #

def load_business_context():
    """Load optional ``hub/business_context.json``. Fails open (empty overlays)
    when the object is absent or invalid.

    Returns (accountDisplayNames: {id: name}, businessUnits: [ {name,
    description, accounts:[id,...]} , ...])."""
    data = read_json("hub/business_context.json")
    if not isinstance(data, dict):
        return {}, []
    display = data.get("accountDisplayNames") or {}
    if not isinstance(display, dict):
        display = {}
    units = []
    for unit in data.get("businessUnits") or []:
        if not isinstance(unit, dict) or not unit.get("name"):
            continue
        accounts = [a for a in (unit.get("accounts") or []) if a]
        units.append({
            "name": unit["name"],
            "description": unit.get("description") or "",
            "accounts": accounts,
        })
    return display, units


def account_label(aid, org_name, display_names):
    """The primary human-friendly label for an account: the configured display
    name when present, otherwise the org account name, otherwise the raw id."""
    return display_names.get(aid) or org_name or aid


#: Activity count keys rendered into the per-space lines of account and
#: Business_Unit docs. The manifest also carries capability-configuration
#: counts (telemetry, pipelines, communications, mcpServers, remoteAgents,
#: webhooks, logDeliveries, users); those are rendered in each space doc's
#: "Configured capabilities" section (with unknown-value handling) instead of
#: being stringified here, where a null would read as a confusing "None".
ACTIVITY_COUNT_KEYS = ("associations", "assets", "skills", "incidents",
                       "investigations", "recommendations")


def activity_counts(counts):
    """Only the activity counts of a manifest space's ``counts`` dict, in a
    stable order, for rendering into KB docs."""
    counts = counts or {}
    return {k: counts[k] for k in ACTIVITY_COUNT_KEYS if k in counts}


def build_account_doc(acct, display_names, account_contexts=None):
    """Render the account overview markdown, applying the display name as the
    primary label while retaining the raw account id for reference. When an
    admin-authored free-text context is present for the account it is included
    so knowledge-base answers reflect it (Requirement 5.2)."""
    account_contexts = account_contexts or {}
    aid = acct["account"]
    org_name = acct.get("name")
    label = account_label(aid, org_name, display_names)
    lines = [f"# AWS account {label} ({aid})", ""]
    display = display_names.get(aid)
    if display and org_name and org_name != display:
        lines.append(f"> Also known as: {org_name}")
    elif display and not org_name:
        lines.append(f"> Account id: {aid}")
    context = account_contexts.get(aid)
    if context:
        lines.append("")
        lines.append(f"**Context:** {context}")
    if acct.get("error"):
        lines.append(f"> Collection error: {acct['error']}")
    lines.append(f"This account has {len(acct.get('spaces', []))} AWS DevOps Agent agent space(s).")
    for sp in acct.get("spaces", []):
        lines.append(f"- **{sp.get('name')}** (`{sp['agentSpaceId']}`): {activity_counts(sp.get('counts'))}")
    return "\n".join(lines)


def build_business_unit_doc(unit, accounts_by_id, display_names):
    """Render one doc for a Business_Unit listing its member accounts and their
    agent spaces so chat answers reflect the grouping (Requirement 5.5)."""
    name = unit["name"]
    lines = [f"# Business Unit: {name}", ""]
    if unit.get("description"):
        lines.append(unit["description"])
        lines.append("")
    lines.append(f"This business unit contains {len(unit['accounts'])} account(s).")
    for aid in unit["accounts"]:
        acct = accounts_by_id.get(aid, {})
        label = account_label(aid, acct.get("name"), display_names)
        lines.append("")
        lines.append(f"## {label} ({aid})")
        spaces = acct.get("spaces", [])
        if not acct:
            lines.append("_No collected data available for this account._")
        elif not spaces:
            lines.append("No AWS DevOps Agent agent spaces.")
        else:
            for sp in spaces:
                lines.append(f"- **{sp.get('name')}** (`{sp['agentSpaceId']}`): {activity_counts(sp.get('counts'))}")
    return "\n".join(lines)


def slugify(text):
    """Filesystem/key-safe slug for a skill name (falls back to 'skill')."""
    s = "".join(ch if ch.isalnum() else "-" for ch in (text or "").lower())
    return s.strip("-") or "skill"


def build_skill_doc(space_name, aid, account_label, sid, region, asset):
    """Render a LEARNED skill's bundle (SKILL.md + references/ component docs)
    into one Markdown KB doc — the architectural "summary report" the DevOps
    Agent console shows for the space. The main SKILL.md leads; each reference
    component doc follows under its own heading so retrieval stays scoped."""
    files = (asset.get("content") or {}).get("skillFiles") or {}
    meta = asset.get("metadata") or {}
    sname = meta.get("name") or asset.get("assetId")
    desc = meta.get("description") or ""
    lines = [
        f"# Architecture summary — {space_name} ({sid})",
        f"Account: {account_label} ({aid})  |  Region: {region}  |  Skill: {sname}",
        "",
    ]
    if desc:
        lines += [desc, ""]
    skill_md = files.get("SKILL.md")
    if skill_md:
        lines += [skill_md.strip(), ""]
    for name in sorted(files):
        if name in ("SKILL.md", "_error"):
            continue
        lines += [f"## Reference: {name}", files[name].strip(), ""]
    if files.get("_error"):
        lines.append(f"> Skill content unavailable: {files['_error']}")
    return "\n".join(lines)


def main():
    display_names, business_units = load_business_context()
    # Per-account free-text context lives in the same business_context.json; read
    # it directly (fails open to {}) so account docs can include it.
    _bc = read_json("hub/business_context.json")
    account_contexts = _bc.get("accountContext") if isinstance(_bc, dict) else None
    account_contexts = account_contexts if isinstance(account_contexts, dict) else {}
    manifest = read_json("raw/_manifest.json", {"accounts": []})
    accounts_by_id = {a["account"]: a for a in manifest["accounts"]}
    n = 0
    for acct in manifest["accounts"]:
        aid = acct["account"]
        name = account_label(aid, acct.get("name"), display_names)
        # account overview doc (display name + context applied)
        put_doc(f"account-{aid}.md", build_account_doc(acct, display_names, account_contexts), aid)
        n += 1

        # per-space detail docs
        for sp in acct.get("spaces", []):
            sid = sp["agentSpaceId"]
            base = f"raw/account={aid}/space={sid}"
            L = [f"# Agent space '{sp.get('name')}' ({sid})",
                 f"Account: {name} ({aid})  |  Region: {manifest.get('region')}", ""]

            assoc = read_json(f"{base}/associations.json", [])
            L.append(f"## Connected services & accounts ({len(assoc)})")
            for a in assoc:
                kind, ref = assoc_target(a.get("configuration"))
                L.append(f"- {a.get('serviceId')} -> **{kind}** `{ref}` (status: {a.get('status')})")

            # Configured capabilities — counts only (no per-configuration
            # detail): capability categories, log-delivery endpoints, and
            # operator-app user access. Sourced from the manifest counts so the
            # doc matches the web app's Space details and BU/org summaries. A
            # metric the collector could not retrieve is null (or absent in
            # pre-capability manifests) and is rendered as "unknown", never a
            # fabricated 0.
            counts = sp.get("counts") or {}
            L.append("\n## Configured capabilities")
            for label, key in (
                ("Telemetry", "telemetry"),
                ("Pipelines", "pipelines"),
                ("Communications", "communications"),
                ("MCP servers", "mcpServers"),
                ("Remote agents", "remoteAgents"),
                ("Webhooks", "webhooks"),
                ("Log delivery endpoints", "logDeliveries"),
                ("Users with access", "users"),
            ):
                value = counts.get(key)
                L.append(f"- {label}: {value if isinstance(value, int) else 'unknown'}")

            assets = read_json(f"{base}/assets.json", [])
            L.append(f"\n## Knowledge assets ({len(assets)})")
            for t, c in Counter(a.get("assetType") for a in assets).items():
                L.append(f"- {t}: {c}")

            # LEARNED skills carry the space's architecture "summary report"
            # (SKILL.md + references/). Emit each as its own KB doc so chat can
            # answer architecture questions (formerly deferred Task 22).
            for a in assets:
                # Only LEARNED skills carry the space's architecture summary
                # report (SKILL.md + references/). Other asset types (memory,
                # memory_store, artifact) also return small single-file bundles,
                # but their content is already covered by the skill's references,
                # so emitting them too would duplicate and add noise.
                if (a.get("assetType") or "") != "skill":
                    continue
                content = a.get("content")
                if not (isinstance(content, dict) and content.get("skillFiles")):
                    continue
                files = content["skillFiles"]
                if not any(k != "_error" for k in files):
                    continue  # nothing usable extracted
                slug = slugify((a.get("metadata") or {}).get("name") or a.get("assetId"))
                put_doc(
                    f"skill-{aid}-{sid}-{slug}.md",
                    build_skill_doc(sp.get("name"), aid, name, sid, manifest.get("region"), a),
                    aid,
                )
                n += 1

            # Incidents == investigations (INVESTIGATION backlog tasks).
            invs = read_json(f"{base}/incidents.json", [])
            L.append(f"\n## Incidents / investigations ({len(invs)})")
            for iv in invs:
                title = iv.get("title") or iv.get("summary") or f"Incident {iv.get('executionId')}"
                meta = [iv.get("taskType"), iv.get("priority"), iv.get("status")]
                suffix = " ".join(f"[{m}]" for m in meta if m)
                L.append(f"### {title} {suffix}".rstrip())
                body = iv.get("description") or iv.get("summary")
                if body:
                    L.append(str(body)[:1000])
                recs = iv.get("journalRecords", [])
                if recs:
                    L.append(f"Journal records: {len(recs)}")

            recs = read_json(f"{base}/recommendations.json", [])
            good = [r for r in recs if isinstance(r, dict) and r.get("recommendationId")]
            L.append(f"\n## Prevention recommendations ({len(good)})")
            for r in good:
                L.append(f"- **{r.get('title')}** (priority {r.get('priority')}, {r.get('status')})")
                if r.get("content"):
                    L.append(f"  {str(r['content'])[:800]}")

            put_doc(f"space-{aid}-{sid}.md", "\n".join(L), aid)
            n += 1

    # one doc per Business_Unit (Requirement 5.5)
    for unit in business_units:
        safe = unit["name"].strip().lower().replace(" ", "-")
        put_doc(f"business-unit-{safe}.md",
                build_business_unit_doc(unit, accounts_by_id, display_names),
                account="*", business_unit=unit["name"])
        n += 1

    print(f"Wrote {n} documents to s3://{BUCKET}/{DOCS}")


if __name__ == "__main__":
    main()
