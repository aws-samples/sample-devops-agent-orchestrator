#!/usr/bin/env python3
"""
Fargate entrypoint for the admin-triggered refresh pipeline (webapp task 10.1).

Runs the existing hub scripts in the order mandated by Requirement 10.1:

    1. collect      -> 03_collect.py
    2. transform    -> 04_transform_to_graph.py
    3. kb_sync      -> 07_build_kb_docs.py + 08_provision_knowledge_base.py --sync
    4. graph_reload -> 05_provision_neptune_and_load.py  (reset + reload)

This mirrors `10_refresh_all.py` (it reuses the same scripts and the same
"only refresh what already exists, never provision new billed resources"
guards) but adds explicit, machine-readable stage markers and a non-zero exit
code on the first failing stage. Step Functions maps that exit code to a failed
execution, and `GET /refresh/status` (task 10.2) surfaces the failing stage from
these markers so the Last_Sync_Date is left unchanged on failure (Req 10.8).

The container sets PIPELINE_CREDENTIALS_MODE=default so `_common.py` uses the
ECS task role (the ambient credential chain) instead of named AWS profiles.
"""
import importlib
import os
import sys

from _common import CFG, hub_session

HERE = os.path.dirname(os.path.abspath(__file__))

# The stage scripts live alongside this file; make them importable when this is
# invoked from another working directory.
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _emit(marker: str) -> None:
    """Emit a machine-readable marker on its own line (parsed by task 10.2)."""
    print(marker, flush=True)


def _banner(label: str) -> None:
    print(f"\n===== {label} =====", flush=True)


# Each stage below imports its module with a LITERAL name and calls main() with
# explicit keyword arguments. No child process, no shell, no argv passing, and
# no computed import target - there is nothing here an external input can steer.
# Imports stay inside the stage functions so a stage that is skipped (no
# Neptune graph, no knowledge base) never imports its module.


def kb_exists() -> bool:
    """True when the managed knowledge base already exists (never provision)."""
    ba = hub_session().client("bedrock-agent")
    for page in ba.get_paginator("list_knowledge_bases").paginate():
        if any(k["name"] == CFG["KB_NAME"] for k in page["knowledgeBaseSummaries"]):
            return True
    return False


def graph_exists() -> bool:
    """True when the Neptune Analytics graph already exists (never provision)."""
    ng = hub_session().client("neptune-graph")
    for page in ng.get_paginator("list_graphs").paginate():
        if any(g["name"] == CFG["NEPTUNE_GRAPH_NAME"] for g in page["graphs"]):
            return True
    return False


def _stage_collect() -> None:
    _banner("03_collect")
    importlib.import_module("03_collect").main()


def _stage_transform() -> None:
    _banner("04_transform_to_graph")
    importlib.import_module("04_transform_to_graph").main()


def _stage_kb_sync() -> None:
    # Regenerate the KB docs (with the latest business context) then ingest them.
    _banner("07_build_kb_docs")
    importlib.import_module("07_build_kb_docs").main()
    if kb_exists():
        _banner("08_provision_knowledge_base (sync)")
        importlib.import_module("08_provision_knowledge_base").main(sync=True)
    else:
        print("\n(KB not provisioned - skipping KB sync)", flush=True)


def _stage_graph_reload() -> None:
    # 05 resets the existing graph to empty then reloads the fresh CSVs.
    if graph_exists():
        _banner("05_provision_neptune_and_load")
        importlib.import_module("05_provision_neptune_and_load").main()
    else:
        print("\n(Neptune graph not provisioned - skipping graph reload)", flush=True)


# Ordered stages (Requirement 10.1). Keep this list in refresh order.
STAGES = [
    ("collect", _stage_collect),
    ("transform", _stage_transform),
    ("kb_sync", _stage_kb_sync),
    ("graph_reload", _stage_graph_reload),
]


def main() -> int:
    _emit("::pipeline::started")
    for name, fn in STAGES:
        _emit(f"::stage::{name}::start")
        try:
            fn()
        # Stages now run in-process, so a SystemExit raised inside one would
        # otherwise bypass this handler and skip the failure markers that
        # GET /refresh/status reads (Req 10.8).
        except (Exception, SystemExit) as exc:  # noqa: BLE001 - report the failing stage and stop
            _emit(f"::stage::{name}::failed")
            _emit(f"::pipeline::failed::{name}")
            print(f"Refresh stage '{name}' failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            return 1
        _emit(f"::stage::{name}::ok")
    _emit("::pipeline::succeeded")
    print("\nRefresh complete.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
