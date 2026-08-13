#!/usr/bin/env python3
"""
Step 11 - render the graph as a self-contained interactive HTML file.

Reads graph/nodes.csv + graph/edges.csv from the hub S3 bucket and writes
graph.html (open it in any browser). Nodes are colored by label with a legend;
drag to explore, hover for details. No pip installs - vis-network loads from a
CDN. This is a snapshot of the last transform; for live exploration of the
running graph use Graph Explorer or a Neptune notebook (see README).

Run with hub credentials (profile 123456789012).
  python3 11_visualize_graph.py                 # -> graph.html
  python3 11_visualize_graph.py --local         # read local /tmp copies instead of S3
"""
import csv
import io
import json
import os
import sys
from _common import CFG, hub_session

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "graph.html")

COLORS = {
    "Account": "#e6552e", "AgentSpace": "#3b7dd8", "Association": "#8e5bd0",
    "Investigation": "#d94a8c", "Recommendation": "#e0a020", "Asset": "#7a8a99",
    "AwsService": "#2ca089", "ExternalTarget": "#c0392b",
}


def read_csv_s3(key):
    s3 = hub_session().client("s3")
    body = s3.get_object(Bucket=CFG["HUB_BUCKET"], Key=key)["Body"].read().decode()
    return list(csv.reader(io.StringIO(body)))


def strip_type(col):
    return col.split(":", 1)[0]


def build():
    nrows = read_csv_s3("graph/nodes.csv")
    erows = read_csv_s3("graph/edges.csv")
    nhdr = [strip_type(c) for c in nrows[0]]
    nodes = []
    for r in nrows[1:]:
        d = dict(zip(nhdr, r))
        label = d.get("~label", "Node")
        title = d.get("name") or d.get("ref") or d.get("accountId") or d["~id"]
        tooltip = " | ".join(f"{k}={v}" for k, v in d.items() if v and k != "~id")
        nodes.append({"id": d["~id"], "label": title, "group": label,
                      "title": f"{label}: {tooltip}",
                      "color": COLORS.get(label, "#999999")})
    ehdr = erows[0]
    edges = [{"from": r[1], "to": r[2], "label": r[3], "arrows": "to",
              "font": {"size": 9, "color": "#888"}} for r in erows[1:]]
    return nodes, edges


HTML = """<!doctype html><html><head><meta charset="utf-8">
<title>DevOps Agent topology graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"
 integrity="sha384-yxKDWWf0wwdUj/gPeuL11czrnKFQROnLgY8ll7En9NYoXibgg3C6NK/UDHNtUgWJ"
 crossorigin="anonymous"></script>
<style>
 body{{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif}}
 #net{{width:100vw;height:100vh}}
 #legend{{position:fixed;top:10px;left:10px;background:rgba(255,255,255,.95);
   padding:10px 12px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.2);font-size:12px}}
 #legend b{{display:block;margin-bottom:6px}}
 .sw{{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:6px;vertical-align:middle}}
 #hdr{{position:fixed;bottom:10px;left:10px;background:rgba(255,255,255,.9);
   padding:6px 10px;border-radius:6px;font-size:11px;color:#444}}
</style></head><body>
<div id="legend"><b>Node types</b>{legend}</div>
<div id="net"></div>
<div id="hdr">{ncount} nodes · {ecount} edges · cross-account links = Association→Account edges</div>
<script>
 const nodes=new vis.DataSet({nodes});
 const edges=new vis.DataSet({edges});
 new vis.Network(document.getElementById('net'),{{nodes,edges}},{{
   nodes:{{shape:'dot',size:14,font:{{size:12}}}},
   edges:{{color:{{color:'#ccc',highlight:'#e6552e'}},smooth:{{type:'continuous'}}}},
   physics:{{stabilization:true,barnesHut:{{gravitationalConstant:-8000,springLength:130}}}},
   interaction:{{hover:true,tooltipDelay:120}}
 }});
</script></body></html>"""


def main():
    nodes, edges = build()
    legend = "".join(
        f'<div><span class="sw" style="background:{c}"></span>{lab}</div>'
        for lab, c in COLORS.items())
    html = HTML.format(legend=legend, nodes=json.dumps(nodes), edges=json.dumps(edges),
                       ncount=len(nodes), ecount=len(edges))
    with open(OUT, "w") as f:
        f.write(html)
    print(f"Wrote {OUT}  ({len(nodes)} nodes, {len(edges)} edges)")
    print(f"Open it:  open '{OUT}'")


if __name__ == "__main__":
    main()
