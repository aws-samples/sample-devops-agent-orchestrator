#!/usr/bin/env python3
"""
Step 10 - one-command periodic refresh. Safe to run on a schedule (cron,
EventBridge Scheduler -> Lambda/Fargate/CodeBuild, or Step Functions).

Pipeline:
  1. collect        (re-pull topology + investigations from every account)
  2. transform      (rebuild graph nodes/edges CSVs in S3)
  3. build_kb_docs  (re-render the KB markdown docs)
  4. KB sync        (only if the managed KB already exists) - incremental
  5. Neptune reload (only if the graph already exists)      - reset + reload

It never *provisions* Neptune or the KB - it only refreshes what you already
created, so a scheduled run can't surprise you with new billed resources.
"""
import importlib
import sys
import os
from _common import CFG, hub_session

HERE = os.path.dirname(os.path.abspath(__file__))

# The step scripts live alongside this file; make them importable when this is
# invoked from another working directory.
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def banner(label):
    print(f"\n===== {label} =====", flush=True)


def kb_exists():
    ba = hub_session().client("bedrock-agent")
    for p in ba.get_paginator("list_knowledge_bases").paginate():
        if any(k["name"] == CFG["KB_NAME"] for k in p["knowledgeBaseSummaries"]):
            return True
    return False


def graph_exists():
    ng = hub_session().client("neptune-graph")
    for p in ng.get_paginator("list_graphs").paginate():
        if any(g["name"] == CFG["NEPTUNE_GRAPH_NAME"] for g in p["graphs"]):
            return True
    return False


def main():
    # Literal module names + explicit keyword arguments: no child process, no
    # shell, no argv passing, and no computed import target. Imports are inside
    # main() so a skipped step never imports its module.
    banner("03_collect")
    importlib.import_module("03_collect").main()

    banner("04_transform_to_graph")
    importlib.import_module("04_transform_to_graph").main()

    banner("07_build_kb_docs")
    importlib.import_module("07_build_kb_docs").main()

    if kb_exists():
        banner("08_provision_knowledge_base (sync)")
        importlib.import_module("08_provision_knowledge_base").main(sync=True)
    else:
        print("\n(KB not provisioned - skipping KB sync)")

    if graph_exists():
        banner("05_provision_neptune_and_load")
        # resets + reloads the existing graph
        importlib.import_module("05_provision_neptune_and_load").main()
    else:
        print("\n(Neptune graph not provisioned - skipping graph reload)")

    print("\nRefresh complete.")


if __name__ == "__main__":
    main()
