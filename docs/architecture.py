#!/usr/bin/env python3
"""Enterprise DevOps Observatory (EDO) — architecture diagram generator.

Renders `docs/architecture.png` with the official AWS icon set via the
`diagrams` library (https://diagrams.mingrammer.com). Regenerate after
architectural changes:

    pip install diagrams   # + `brew install graphviz`
    python3 docs/architecture.py

Covers the full solution as of Task 39:
  - SPA (Amplify Hosting) + Cognito auth (SPA client and the external MCP
    Hosted-UI/PKCE client) + JWT-protected HTTP API and its route Lambdas.
  - Data & AI plane: hub S3 bucket, Neptune Analytics topology (GraphRAG),
    Bedrock Knowledge Base + model (AgenticRetrieve).
  - Refresh pipeline: Step Functions Distributed Map fanning collectors out
    across member accounts via the cross-account collector role.
  - A2A plane: per-space Bearer tokens in Secrets Manager, the a2a route
    Lambda, and the Lambda DURABLE FUNCTION driving async chat/investigate
    against DevOps Agent Spaces.
  - MCP plane: the internal (AWS_IAM) and external (CUSTOM_JWT) AgentCore
    Gateways and their tools Lambdas; external AI apps (Kiro/Claude) connect
    with the user's own EDO credentials via OAuth PKCE.
"""

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Neptune
from diagrams.aws.integration import StepFunctions
from diagrams.aws.management import Organizations
from diagrams.aws.ml import Bedrock
from diagrams.aws.mobile import Amplify
from diagrams.aws.network import APIGateway
from diagrams.aws.security import Cognito, IdentityAndAccessManagementIam, SecretsManager
from diagrams.aws.storage import S3
from diagrams.onprem.client import Client, Users

GRAPH_ATTR = {
    "fontsize": "22",
    "pad": "0.4",
    "nodesep": "0.9",
    "ranksep": "1.1",
    "splines": "spline",
}

with Diagram(
    "Enterprise DevOps Observatory (EDO)",
    filename="docs/architecture",
    outformat="png",
    show=False,
    direction="LR",
    graph_attr=GRAPH_ATTR,
):
    # ------------------------------------------------------------------ users
    with Cluster("Users & AI clients"):
        users = Users("EDO users\n(Executive / Admin)")
        ai_apps = Client("External AI apps\nKiro / Claude / bots\n(MCP + OAuth PKCE)")

    # ------------------------------------------------------------- hub account
    with Cluster("AWS hub account"):
        with Cluster("Web app (Amplify Gen 2)"):
            spa = Amplify("Amplify Hosting\nReact SPA")
            cognito = Cognito("Cognito user pool\nSPA client + external\nPKCE client (Hosted UI)")

        with Cluster("API layer"):
            api = APIGateway("HTTP API\nCognito JWT authorizer")
            api_lambdas = Lambda("Route Lambdas\nsummary / dashboard /\ngraph / chat / settings…")
            a2a_lambda = Lambda("a2a routes\ntoken mgmt +\nchat / investigate")

        with Cluster("A2A plane"):
            durable = Lambda("Durable function\n(async A2A chat +\ninvestigate, human gate)")
            secrets = SecretsManager("Per-space A2A\nBearer tokens")

        with Cluster("Data & AI plane"):
            hub_bucket = S3("Hub bucket\nmanifest / KB docs /\ncontext / settings")
            neptune = Neptune("Neptune Analytics\ntopology (GraphRAG)")
            kb = Bedrock("Bedrock KB + model\n(AgenticRetrieve)")

        with Cluster("Refresh pipeline"):
            sfn = StepFunctions("Step Functions\nDistributed Map")
            collectors = Lambda("Python collector /\nfinalize workers")

        with Cluster("MCP plane (Bedrock AgentCore)"):
            gw_internal = Bedrock("AgentCore Gateway\ninternal (AWS_IAM)")
            gw_external = Bedrock("AgentCore Gateway\nexternal (CUSTOM_JWT)")
            mcp_tools = Lambda("mcp-tools\nsnapshot tools")
            mcp_external = Lambda("mcp-external\n+ ask_devops_observatory\n+ ask_agent_space\n(admin kill switch)")

    # -------------------------------------------------------- member accounts
    with Cluster("AWS Organizations — member accounts"):
        org = Organizations("Organizations\naccount listing")
        collector_role = IdentityAndAccessManagementIam("Collector role\n(cross-account, read-only)")
        spaces = Bedrock("AWS DevOps Agent\nSpaces (per account)")

    # ------------------------------------------------------------------ edges
    # Web app path.
    users >> spa >> Edge(label="JWT") >> api
    spa >> Edge(style="dashed", label="sign-in") >> cognito
    api >> api_lambdas
    api >> a2a_lambda

    # Route Lambdas ground answers in the three sources.
    api_lambdas >> hub_bucket
    api_lambdas >> neptune
    api_lambdas >> kb

    # A2A: tokens stay server-side; durable function polls the space.
    a2a_lambda >> secrets
    a2a_lambda >> Edge(label="async invoke + poll") >> durable
    durable >> secrets
    durable >> Edge(label="A2A chat/investigate\n(Bearer)") >> spaces
    durable >> Edge(style="dashed") >> hub_bucket

    # Refresh fan-out.
    api_lambdas >> Edge(style="dashed", label="admin refresh") >> sfn
    sfn >> collectors
    collectors >> Edge(label="assume") >> collector_role >> spaces
    collectors >> org
    collectors >> Edge(label="manifest + KB docs") >> hub_bucket
    collectors >> neptune

    # MCP plane.
    ai_apps >> Edge(label="MCP over HTTPS\n(Bearer JWT)") >> gw_external
    ai_apps >> Edge(style="dashed", label="OAuth PKCE\nsign-in") >> cognito
    gw_external >> mcp_external
    gw_internal >> mcp_tools
    mcp_external >> kb
    mcp_external >> neptune
    mcp_external >> hub_bucket
    mcp_external >> secrets
    mcp_external >> Edge(label="A2A chat relay") >> spaces
    mcp_tools >> kb
    mcp_tools >> neptune
    mcp_tools >> hub_bucket

print("wrote docs/architecture.png")
