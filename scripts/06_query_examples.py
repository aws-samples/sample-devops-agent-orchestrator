#!/usr/bin/env python3
"""
Step 6 - run example openCypher queries against the loaded graph.
Run with hub credentials (profile 123456789012).

NOTE: this reaches the graph endpoint directly, so it must run somewhere that
can reach it. By default the graph is created VPC-only
(NEPTUNE_PUBLIC_CONNECTIVITY=false in config.env), so run this from inside the
VPC - from a laptop the connection will simply time out. See README,
"Running the Guidance".
"""
import sys
from _common import CFG, hub_session

NG = hub_session().client("neptune-graph")


def gid():
    for g in NG.get_paginator("list_graphs").paginate():
        for it in g["graphs"]:
            if it["name"] == CFG["NEPTUNE_GRAPH_NAME"]:
                return it["id"]
    raise SystemExit("Graph not found - run step 5 first.")


QUERIES = {
    "accounts_and_spaces":
        "MATCH (a:Account)-[:HAS_SPACE]->(s:AgentSpace) "
        "RETURN a.accountId AS account, a.name AS name, collect(s.name) AS spaces",

    # Cross-account: two agent spaces in DIFFERENT accounts that connect to the
    # same target (AWS account or external service) => a shared relationship.
    "cross_account_shared_targets":
        "MATCH (a1:Account)-[:HAS_SPACE]->(:AgentSpace)-[:HAS_ASSOCIATION]->"
        "(:Association)-[r]->(t) "
        "MATCH (a2:Account)-[:HAS_SPACE]->(:AgentSpace)-[:HAS_ASSOCIATION]->"
        "(:Association)-[r2]->(t) "
        "WHERE a1.accountId < a2.accountId "
        "RETURN a1.accountId AS accountA, a2.accountId AS accountB, "
        "labels(t)[0] AS targetType, coalesce(t.ref, t.accountId) AS target",

    # Which AWS services each account touches (associations + investigations).
    "services_per_account":
        "MATCH (a:Account)-[:HAS_SPACE]->(:AgentSpace)-[:USES_SERVICE]->(svc:AwsService) "
        "RETURN a.accountId AS account, collect(DISTINCT svc.name) AS services",

    # Investigations and the services they referenced.
    "investigation_service_map":
        "MATCH (i:Investigation)-[:REFERENCES_SERVICE]->(svc:AwsService) "
        "RETURN i.account AS account, i.summary AS investigation, "
        "collect(DISTINCT svc.name) AS services",

    "graph_summary":
        "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC",
}


def run(name, g):
    print(f"\n===== {name} =====")
    r = NG.execute_query(graphIdentifier=g, queryString=QUERIES[name], language="OPEN_CYPHER")
    print(r["payload"].read().decode())


def main():
    g = gid()
    which = sys.argv[1:] or list(QUERIES)
    for name in which:
        if name in QUERIES:
            run(name, g)
        else:
            print(f"(unknown query '{name}'; options: {', '.join(QUERIES)})")


if __name__ == "__main__":
    main()
