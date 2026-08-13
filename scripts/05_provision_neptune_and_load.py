#!/usr/bin/env python3
"""
Step 5 - provision Neptune Analytics in the hub, load the graph CSVs from S3,
and run a sample cross-account query.

  *** THIS STEP CREATES A BILLED RESOURCE ***
  A Neptune Analytics graph bills per m-NCU-hour for as long as it exists.
  Delete it when done:  python3 scripts/05_provision_neptune_and_load.py --delete

Steps: (1) create IAM role Neptune uses to read S3, (2) create the graph,
(3) start-import-task from s3://<bucket>/graph/, (4) sample query.
Run with hub credentials (profile 123456789012).
"""
import json
import sys
import time
from botocore.exceptions import ClientError
from _common import CFG, hub_session

REGION = CFG["REGION"]
BUCKET = CFG["HUB_BUCKET"]
GRAPH_NAME = CFG["NEPTUNE_GRAPH_NAME"]
LOAD_ROLE = CFG["NEPTUNE_LOAD_ROLE_NAME"]
MEMORY = int(CFG.get("NEPTUNE_MEMORY", "128"))

# Public connectivity is OFF by default: a graph reachable from the public
# internet relies solely on IAM/SigV4 as its perimeter, so a leaked or overly
# broad credential exposes the whole topology graph. With this disabled the
# graph is only reachable from inside the VPC, which keeps the network as a
# second line of defence alongside IAM.
#
# Trade-off: openCypher calls (`execute_query`, used by this script's sample
# query and by 06_query_examples.py) will NOT work from a laptop when this is
# false - run them from inside the VPC instead (see README, "Running the
# Guidance"). Set NEPTUNE_PUBLIC_CONNECTIVITY=true in config.env only for
# development, and understand you are trading away that network boundary.
PUBLIC_CONNECTIVITY = CFG.get("NEPTUNE_PUBLIC_CONNECTIVITY", "false").strip().lower() == "true"

SESS = hub_session()
NG = SESS.client("neptune-graph")
IAM = SESS.client("iam")


def ensure_load_role():
    trust = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "neptune-graph.amazonaws.com"},
        "Action": "sts:AssumeRole"}]}
    perm = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Action": ["s3:GetObject", "s3:ListBucket"],
        "Resource": [f"arn:aws:s3:::{BUCKET}", f"arn:aws:s3:::{BUCKET}/*"]}]}
    try:
        arn = IAM.create_role(RoleName=LOAD_ROLE,
                              AssumeRolePolicyDocument=json.dumps(trust))["Role"]["Arn"]
        print(f"Created {LOAD_ROLE}")
    except IAM.exceptions.EntityAlreadyExistsException:
        arn = IAM.get_role(RoleName=LOAD_ROLE)["Role"]["Arn"]
        print(f"{LOAD_ROLE} exists")
    IAM.put_role_policy(RoleName=LOAD_ROLE, PolicyName="ReadHubBucket",
                        PolicyDocument=json.dumps(perm))
    time.sleep(10)  # let the role propagate before Neptune assumes it
    return arn


def graph_id():
    for g in NG.get_paginator("list_graphs").paginate():
        for it in g["graphs"]:
            if it["name"] == GRAPH_NAME:
                return it["id"]
    return None


def ensure_graph():
    gid = graph_id()
    if gid:
        print(f"Graph {GRAPH_NAME} exists ({gid})")
        return gid
    reach = "public+IAM" if PUBLIC_CONNECTIVITY else "VPC-only+IAM"
    print(f"Creating graph {GRAPH_NAME} ({MEMORY} m-NCU, {reach} connectivity) ...")
    gid = NG.create_graph(graphName=GRAPH_NAME, provisionedMemory=MEMORY,
                          publicConnectivity=PUBLIC_CONNECTIVITY,
                          deletionProtection=False,
                          replicaCount=0)["id"]
    waiter = NG.get_waiter("graph_available")
    waiter.wait(graphIdentifier=gid)
    print(f"Graph available ({gid})")
    return gid


def reset_if_needed(gid, snapshot=False):
    """StartImportTask requires an EMPTY graph. On a refresh the graph already
    holds the previous snapshot, so we empty it first (optionally snapshotting).
    A full reset+reload is the correct refresh model for a topology that changes
    over time - resources/associations that disappeared are dropped cleanly."""
    summary = NG.get_graph_summary(graphIdentifier=gid, mode="BASIC").get("graphSummary", {})
    nodes = summary.get("numNodes", 0)
    if not nodes:
        return
    print(f"Graph already has {nodes} nodes - refreshing (reset then reload).")
    if snapshot:
        snap = f"{CFG['NEPTUNE_GRAPH_NAME']}-{int(time.time())}"
        NG.create_graph_snapshot(graphIdentifier=gid, snapshotName=snap)
        NG.get_waiter("graph_snapshot_available").wait(snapshotIdentifier=snap)
        print(f"  snapshot {snap} created")
    NG.reset_graph(graphIdentifier=gid, skipSnapshot=not snapshot)
    NG.get_waiter("graph_available").wait(graphIdentifier=gid)
    print("  graph reset to empty")


def load(gid, role_arn, snapshot_before_reset=False):
    reset_if_needed(gid, snapshot=snapshot_before_reset)
    print(f"Starting import from s3://{BUCKET}/graph/ ...")
    task = NG.start_import_task(
        graphIdentifier=gid, roleArn=role_arn,
        source=f"s3://{BUCKET}/graph/", format="CSV", failOnError=False,
    )["taskId"]
    while True:
        t = NG.get_import_task(taskIdentifier=task)
        st = t["status"]
        print(f"  import {task}: {st}")
        if st in ("SUCCEEDED", "FAILED", "CANCELLED", "ROLLING_BACK", "CANCELLING"):
            if st != "SUCCEEDED":
                print("  details:", json.dumps(t.get("importOptions", {}), default=str)[:300],
                      t.get("statusReason", ""))
            break
        time.sleep(15)


def sample_query(gid):
    # A VPC-only graph is not reachable from outside the VPC, so the sample
    # query is skipped rather than failed - the load above has already
    # succeeded and that is what this step is responsible for.
    if not PUBLIC_CONNECTIVITY:
        print("\nSample query skipped: the graph is VPC-only "
              "(NEPTUNE_PUBLIC_CONNECTIVITY=false). Run openCypher queries from "
              "inside the VPC - see README, 'Running the Guidance'.")
        return
    q = """
    MATCH (a:Account)-[:HAS_SPACE]->(s:AgentSpace)-[:USES_SERVICE]->(svc:AwsService)
    RETURN a.name AS account, svc.name AS service, count(*) AS uses
    ORDER BY account, service
    """
    print("\nSample query - services used per account:")
    r = NG.execute_query(graphIdentifier=gid, queryString=q, language="OPEN_CYPHER")
    print(r["payload"].read().decode())


def delete():
    gid = graph_id()
    if gid:
        NG.delete_graph(graphIdentifier=gid, skipSnapshot=True)
        print(f"Deleting graph {gid} ...")
    try:
        IAM.delete_role_policy(RoleName=LOAD_ROLE, PolicyName="ReadHubBucket")
        IAM.delete_role(RoleName=LOAD_ROLE)
        print(f"Deleted {LOAD_ROLE}")
    except ClientError as e:
        print("role cleanup:", str(e)[:120])


# --------------------------------------------------------------------------- #
# Refresh fan-out helpers (webapp task 26.3): start the reset+reload on the
# EXISTING graph and poll it once. The state machine owns the wait loop, so no
# long poll runs inside a Lambda. Never provisions a graph.
# --------------------------------------------------------------------------- #

# Neptune import terminal statuses (anything else means still running).
IMPORT_TERMINAL = ("SUCCEEDED", "FAILED", "CANCELLED", "ROLLING_BACK", "CANCELLING")


def start_reload():
    gid = graph_id()
    if not gid:
        raise RuntimeError(f"Neptune graph {GRAPH_NAME} not found; provision it before refreshing.")
    role_arn = ensure_load_role()
    reset_if_needed(gid, snapshot=False)
    task = NG.start_import_task(
        graphIdentifier=gid, roleArn=role_arn,
        source=f"s3://{BUCKET}/graph/", format="CSV", failOnError=False,
    )["taskId"]
    return {"graphId": gid, "taskId": task}


def poll_reload(task_id):
    t = NG.get_import_task(taskIdentifier=task_id)
    status = t["status"]
    return {
        "taskId": task_id,
        "status": status,
        "done": status in IMPORT_TERMINAL,
        "succeeded": status == "SUCCEEDED",
        "statusReason": t.get("statusReason", ""),
    }


def main(*, delete_graph: bool = False, snapshot: bool = False):
    """Entry point. Options are explicit parameters (not read from sys.argv) so
    the refresh pipeline can import and call this directly."""
    if delete_graph:
        delete()
        return
    role_arn = ensure_load_role()
    gid = ensure_graph()
    load(gid, role_arn, snapshot_before_reset=snapshot)
    sample_query(gid)
    print(f"\nGraph ready: {gid}. Run scripts/06_query_examples.py for more queries.")


if __name__ == "__main__":
    main(delete_graph="--delete" in sys.argv, snapshot="--snapshot" in sys.argv)
