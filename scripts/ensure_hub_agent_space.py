#!/usr/bin/env python3
"""
Ensure the HUB account has an AWS DevOps Agent Space, and keep its details in
the hub (persisted to s3://<hub-bucket>/hub/agent_spaces.json).

- If one or more agent spaces exist: record their details and exit.
- If none exist: prompt the user to create one (or pass --create-name / --yes).

Run with hub credentials (profile 123456789012).
  python3 ensure_hub_agent_space.py
  python3 ensure_hub_agent_space.py --create-name "hub-devops-agent" --yes
"""
import json
import sys
import datetime as dt
from _common import CFG, hub_session, confirm

SESS = hub_session()
DA = SESS.client("devops-agent")
S3 = SESS.client("s3")
BUCKET = CFG["HUB_BUCKET"]


def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def list_spaces():
    spaces, tok = [], None
    while True:
        kw = {"maxResults": 100}
        if tok:
            kw["nextToken"] = tok
        r = DA.list_agent_spaces(**kw)
        spaces += r.get("agentSpaces", [])
        tok = r.get("nextToken")
        if not tok:
            return spaces


def persist(spaces):
    detailed = []
    for sp in spaces:
        try:
            detailed.append(DA.get_agent_space(agentSpaceId=sp["agentSpaceId"])["agentSpace"])
        except Exception:  # noqa: BLE001
            detailed.append(sp)
    doc = {"account": CFG["HUB_ACCOUNT_ID"], "region": CFG["REGION"],
           "recordedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
           "agentSpaces": detailed}
    S3.put_object(Bucket=BUCKET, Key="hub/agent_spaces.json",
                  Body=json.dumps(doc, default=str, indent=2).encode(),
                  ContentType="application/json")
    print(f"Recorded {len(detailed)} hub agent space(s) -> s3://{BUCKET}/hub/agent_spaces.json")


def main():
    spaces = list_spaces()
    if spaces:
        print(f"Hub account {CFG['HUB_ACCOUNT_ID']} has {len(spaces)} agent space(s):")
        for sp in spaces:
            print(f"  - {sp['agentSpaceId']} | {sp.get('name')}")
        persist(spaces)
        return

    print(f"No DevOps Agent Space found in hub account {CFG['HUB_ACCOUNT_ID']} ({CFG['REGION']}).")
    default_name = arg("--create-name") or f"hub-devops-agent-{CFG['HUB_ACCOUNT_ID']}"
    if not confirm(f"Create a new agent space named '{default_name}' in the hub?"):
        print("No agent space created. The hub needs an agent space to run "
              "investigations and build topology. Re-run this script when ready.")
        return
    sp = DA.create_agent_space(
        name=default_name,
        description="Central hub agent space for cross-account DevOps observability.",
    )["agentSpace"]
    print(f"Created agent space {sp['agentSpaceId']} ({sp.get('name')})")
    persist(list_spaces())


if __name__ == "__main__":
    main()
