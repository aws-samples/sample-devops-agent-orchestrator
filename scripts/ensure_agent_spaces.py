#!/usr/bin/env python3
"""
Ensure EVERY account in the org (hub + management + linked) has at least one
AWS DevOps Agent Space. Reports which accounts have none and, unless run in
--check-only mode, creates a starter space where missing. A summary is kept in
the hub at s3://<hub-bucket>/hub/agent_spaces_all.json.

Access model:
  - hub / management: uses their direct admin credentials (can create).
  - linked accounts : uses the assumed DevOpsAgentCollectorRole. Creating a
    space there requires the role to allow aidevops:CreateAgentSpace, i.e.
    deploy step 1 with ALLOW_AGENT_SPACE_CREATION=true in config.env. Without
    it, listing still works and missing accounts are reported.

Run with hub credentials (profile 123456789012); org listing uses the
management profile automatically.
  python3 ensure_agent_spaces.py                 # create where missing (prompts)
  python3 ensure_agent_spaces.py --check-only     # report only, no changes
  python3 ensure_agent_spaces.py --yes            # create without prompting
  python3 ensure_agent_spaces.py --account 345678901234   # target one account
"""
import json
import sys
import datetime as dt
from botocore.exceptions import ClientError
from _common import CFG, hub_session, list_org_accounts, assume_collector, confirm

CHECK_ONLY = "--check-only" in sys.argv
S3 = hub_session().client("s3")


def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def list_spaces(client):
    spaces, tok = [], None
    while True:
        kw = {"maxResults": 100}
        if tok:
            kw["nextToken"] = tok
        r = client.list_agent_spaces(**kw)
        spaces += r.get("agentSpaces", [])
        tok = r.get("nextToken")
        if not tok:
            return spaces


def main():
    only = arg("--account")
    accounts = [a for a in list_org_accounts() if not only or a["id"] == only]
    summary = {"checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
               "region": CFG["REGION"], "accounts": []}
    created, missing_no_perm = 0, 0

    for acct in accounts:
        aid, name = acct["id"], acct["name"]
        row = {"account": aid, "name": name, "spaces": [], "action": None, "error": None}
        try:
            client = assume_collector(aid).client("devops-agent")
            spaces = list_spaces(client)
            row["spaces"] = [{"id": s["agentSpaceId"], "name": s.get("name")} for s in spaces]

            if spaces:
                row["action"] = "ok"
                print(f"[{aid}] {name}: OK ({len(spaces)} space(s))")
            elif CHECK_ONLY:
                row["action"] = "missing"
                print(f"[{aid}] {name}: MISSING - no agent space")
            else:
                new_name = f"devops-agent-{aid}"
                if not confirm(f"[{aid}] {name} has no agent space. Create '{new_name}'?"):
                    row["action"] = "skipped"
                    print(f"[{aid}] {name}: skipped")
                else:
                    try:
                        sp = client.create_agent_space(
                            name=new_name,
                            description=f"Starter agent space for account {aid}.",
                        )["agentSpace"]
                        row["spaces"].append({"id": sp["agentSpaceId"], "name": sp.get("name")})
                        row["action"] = "created"
                        created += 1
                        print(f"[{aid}] {name}: CREATED {sp['agentSpaceId']}")
                    except ClientError as e:
                        if e.response["Error"]["Code"] in ("AccessDeniedException", "AccessDenied"):
                            row["action"] = "create_denied"
                            row["error"] = "collector role lacks aidevops:CreateAgentSpace"
                            missing_no_perm += 1
                            print(f"[{aid}] {name}: MISSING - cannot create (role is read-only). "
                                  "Redeploy step 1 with ALLOW_AGENT_SPACE_CREATION=true.")
                        else:
                            raise
        except ClientError as e:
            row["action"] = "error"
            row["error"] = f"{e.response['Error']['Code']}: {e.response['Error']['Message'][:120]}"
            print(f"[{aid}] {name}: ERROR - {row['error']} "
                  "(deploy step 1 so the collector role exists?)")
        summary["accounts"].append(row)

    S3.put_object(Bucket=CFG["HUB_BUCKET"], Key="hub/agent_spaces_all.json",
                  Body=json.dumps(summary, indent=2).encode(), ContentType="application/json")
    missing = [r for r in summary["accounts"] if r["action"] in ("missing", "create_denied", "error")]
    print(f"\nSummary -> s3://{CFG['HUB_BUCKET']}/hub/agent_spaces_all.json")
    print(f"  created: {created} | still missing/blocked: {len(missing)}")
    if missing_no_perm:
        print("  Note: set ALLOW_AGENT_SPACE_CREATION=true and re-run step 1, then re-run this.")


if __name__ == "__main__":
    main()
