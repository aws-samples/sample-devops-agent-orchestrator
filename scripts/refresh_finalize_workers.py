#!/usr/bin/env python3
"""
Finalize-stage worker handlers for the refresh state machine (webapp task 26.3).

After the collect Distributed Map + AssembleManifest have rebuilt the manifest
and raw shards, the finalize stages run ONCE over the full dataset:

  transform    -> 04_transform_to_graph.py (build graph CSVs) + 07_build_kb_docs.py
  kb_sync      -> start an incremental ingestion on the existing KB, then the
                  state machine polls poll_kb until it completes.
  graph_reload -> reset the existing Neptune graph + start a fresh import, then
                  the state machine polls poll_graph until it completes.

The long-running KB ingestion and Neptune import are NOT polled inside a Lambda:
each `start_*` returns the job/task id, and the state machine drives a
Wait -> `poll_*` -> Choice loop, so no Lambda runs longer than a single status
check (no 15-minute ceiling on the wait). All logic is reused from the existing
scripts (single source of truth); this module only adapts them to the Lambda
handler signature.
"""
import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(mod_name, filename):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Loaded lazily-per-container at import (module-level clients are created lazily).
_transform = _load("transform_mod", "04_transform_to_graph.py")
_kbdocs = _load("kbdocs_mod", "07_build_kb_docs.py")
_neptune = _load("neptune_mod", "05_provision_neptune_and_load.py")
_kb = _load("kb_mod", "08_provision_knowledge_base.py")


def transform(_event=None, _context=None):
    """Rebuild the graph CSVs (04) then the KB markdown docs (07) from raw."""
    _transform.build()
    _transform.write_csv()
    _kbdocs.main()
    return {"ok": True, "stage": "transform"}


def start_kb(_event=None, _context=None):
    """Start an incremental ingestion on the existing KB (kb_sync stage)."""
    return _kb.start_sync()


def poll_kb(event, _context=None):
    """One status check of the ingestion job started by {@link start_kb}."""
    return _kb.poll_sync(event["kbId"], event["dataSourceId"], event["ingestionJobId"])


def start_graph(_event=None, _context=None):
    """Reset the existing graph + start a fresh import (graph_reload stage)."""
    return _neptune.start_reload()


def poll_graph(event, _context=None):
    """One status check of the Neptune import task started by {@link start_graph}."""
    return _neptune.poll_reload(event["taskId"])
