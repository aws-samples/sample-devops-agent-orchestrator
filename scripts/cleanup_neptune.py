#!/usr/bin/env python3
"""
CLEANUP - Neptune Analytics (the main hourly cost). Deletes the graph, any of
its snapshots, and the Neptune S3-load role. Does NOT touch S3 data.

Run with hub credentials (profile 123456789012).
  python3 cleanup_neptune.py            # prompts for confirmation
  python3 cleanup_neptune.py --yes      # no prompt (for automation)
  python3 cleanup_neptune.py --keep-snapshots
"""
import sys
from botocore.exceptions import ClientError
from _common import CFG, hub_session, confirm

SESS = hub_session()
NG = SESS.client("neptune-graph")
IAM = SESS.client("iam")
NAME = CFG["NEPTUNE_GRAPH_NAME"]


def graph_id():
    for p in NG.get_paginator("list_graphs").paginate():
        for g in p["graphs"]:
            if g["name"] == NAME:
                return g["id"]
    return None


def delete_snapshots():
    try:
        snaps = NG.list_graph_snapshots().get("graphSnapshots", [])
    except ClientError:
        return
    for s in snaps:
        if s["name"].startswith(NAME):
            NG.delete_graph_snapshot(snapshotIdentifier=s["id"])
            print(f"  deleted snapshot {s['name']} ({s['id']})")


def delete_role():
    role = CFG["NEPTUNE_LOAD_ROLE_NAME"]
    try:
        for p in IAM.list_role_policies(RoleName=role)["PolicyNames"]:
            IAM.delete_role_policy(RoleName=role, PolicyName=p)
        IAM.delete_role(RoleName=role)
        print(f"  deleted role {role}")
    except IAM.exceptions.NoSuchEntityException:
        print(f"  role {role} already gone")


def main():
    gid = graph_id()
    if not gid:
        print(f"No graph named {NAME}. Checking for leftover role/snapshots ...")
    else:
        print(f"Graph {NAME} = {gid}")
    if not confirm(f"Delete Neptune graph '{NAME}', its snapshots, and the load role?"):
        print("Aborted.")
        return
    if gid:
        NG.delete_graph(graphIdentifier=gid, skipSnapshot=True)
        print(f"  deleting graph {gid} ...")
        try:
            NG.get_waiter("graph_deleted").wait(graphIdentifier=gid)
        except ClientError:
            pass
    if "--keep-snapshots" not in sys.argv:
        delete_snapshots()
    delete_role()
    print("Neptune cleanup complete.")


if __name__ == "__main__":
    main()
