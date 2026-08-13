#!/usr/bin/env python3
"""
Step 8 - create a Bedrock MANAGED knowledge base in the hub, attach the S3
data source (the kb/ docs), and run an ingestion job. Bedrock manages the
vector store (S3 Vectors under the hood) - no OpenSearch, no index to manage.

  Billing: pay-per-use (embedding + query tokens + managed vector storage).
  No standing per-hour compute cost like OpenSearch Serverless.

Run with hub credentials (profile 123456789012).
  python3 08_provision_knowledge_base.py            # create + ingest
  python3 08_provision_knowledge_base.py --sync      # re-run ingestion only
  python3 08_provision_knowledge_base.py --delete    # tear down
"""
import json
import sys
import time
from botocore.exceptions import ClientError
from _common import CFG, hub_session

BUCKET = CFG["HUB_BUCKET"]
DOCS = CFG["KB_DOCS_PREFIX"]
SESS = hub_session()
BA = SESS.client("bedrock-agent")
IAM = SESS.client("iam")
ACCT = CFG["HUB_ACCOUNT_ID"]


def ensure_role():
    name = CFG["KB_ROLE_NAME"]
    trust = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "bedrock.amazonaws.com"},
        "Action": "sts:AssumeRole",
        "Condition": {"StringEquals": {"aws:SourceAccount": ACCT}}}]}
    perm = {"Version": "2012-10-17", "Statement": [
        {"Sid": "Embed", "Effect": "Allow", "Action": ["bedrock:InvokeModel"],
         "Resource": [CFG["KB_EMBED_MODEL_ARN"]]},
        {"Sid": "ReadDocs", "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:ListBucket"],
         "Resource": [f"arn:aws:s3:::{BUCKET}", f"arn:aws:s3:::{BUCKET}/*"],
         "Condition": {"StringEquals": {"aws:ResourceAccount": ACCT}}}]}
    try:
        arn = IAM.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps(trust),
                              Description="Bedrock managed KB service role")["Role"]["Arn"]
        print(f"Created {name}")
    except IAM.exceptions.EntityAlreadyExistsException:
        arn = IAM.get_role(RoleName=name)["Role"]["Arn"]
        print(f"{name} exists")
    IAM.put_role_policy(RoleName=name, PolicyName="KbAccess", PolicyDocument=json.dumps(perm))
    time.sleep(10)
    return arn


def find_kb():
    for p in BA.get_paginator("list_knowledge_bases").paginate():
        for kb in p["knowledgeBaseSummaries"]:
            if kb["name"] == CFG["KB_NAME"]:
                return kb["knowledgeBaseId"]
    return None


def find_ds(kb_id):
    for p in BA.get_paginator("list_data_sources").paginate(knowledgeBaseId=kb_id):
        for ds in p["dataSourceSummaries"]:
            return ds["dataSourceId"]
    return None


def create_kb(role_arn):
    print(f"Creating MANAGED knowledge base {CFG['KB_NAME']} ...")
    kb = BA.create_knowledge_base(
        name=CFG["KB_NAME"],
        description="Cross-account AWS DevOps Agent topology & investigations.",
        roleArn=role_arn,
        knowledgeBaseConfiguration={
            "type": "MANAGED",
            "managedKnowledgeBaseConfiguration": {
                "embeddingModelArn": CFG["KB_EMBED_MODEL_ARN"],
                "embeddingModelType": "CUSTOM",
                "embeddingModelConfiguration": {
                    "bedrockEmbeddingModelConfiguration": {"embeddingDataType": "FLOAT32"}
                },
            },
        },
    )["knowledgeBase"]
    kid = kb["knowledgeBaseId"]
    for _ in range(60):
        st = BA.get_knowledge_base(knowledgeBaseId=kid)["knowledgeBase"]["status"]
        if st == "ACTIVE":
            break
        if st == "FAILED":
            raise SystemExit("KB creation FAILED: " +
                             str(BA.get_knowledge_base(knowledgeBaseId=kid)["knowledgeBase"].get("failureReasons")))
        time.sleep(5)
    print(f"KB active: {kid}")
    return kid


def create_ds(kb_id):
    print("Creating managed S3 data source ...")
    ds_id = BA.create_data_source(
        knowledgeBaseId=kb_id, name="devops-agent-docs",
        dataSourceConfiguration={
            "type": "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
            "managedKnowledgeBaseConnectorConfiguration": {
                "connectorParameters": {
                    "type": "S3",
                    "version": "1",
                    "connectionConfiguration": {
                        "bucketName": BUCKET,
                        "bucketOwnerAccountId": ACCT,
                    },
                    "filterConfiguration": {"inclusionPrefixes": [DOCS]},
                }
            },
        },
    )["dataSource"]["dataSourceId"]
    # CreateDataSource is async for managed KBs - wait for AVAILABLE.
    for _ in range(60):
        st = BA.get_data_source(knowledgeBaseId=kb_id, dataSourceId=ds_id)["dataSource"]["status"]
        if st == "AVAILABLE":
            break
        if st == "FAILED":
            raise SystemExit("Data source creation FAILED")
        time.sleep(5)
    print(f"Data source available: {ds_id}")
    return ds_id


def ingest(kb_id, ds_id):
    job = BA.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)["ingestionJob"]["ingestionJobId"]
    print(f"Ingestion job {job} started ...")
    while True:
        j = BA.get_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id, ingestionJobId=job)["ingestionJob"]
        st = j["status"]
        print(f"  ingestion: {st}")
        if st in ("COMPLETE", "FAILED"):
            print("  stats:", json.dumps(j.get("statistics", {}), default=str))
            if st == "FAILED":
                print("  reasons:", j.get("failureReasons"))
            return
        time.sleep(10)


# --------------------------------------------------------------------------- #
# Refresh fan-out helpers (webapp task 26.3): start an incremental ingestion on
# the EXISTING KB + data source and poll it once. The state machine owns the
# wait loop, so no long poll runs inside a Lambda. Never provisions a KB.
# --------------------------------------------------------------------------- #

def start_sync():
    kid = find_kb()
    if not kid:
        raise RuntimeError(f"Knowledge base {CFG['KB_NAME']} not found; provision it before refreshing.")
    ds_id = find_ds(kid)
    if not ds_id:
        raise RuntimeError("Knowledge base data source not found; provision it before refreshing.")
    job = BA.start_ingestion_job(knowledgeBaseId=kid, dataSourceId=ds_id)["ingestionJob"]["ingestionJobId"]
    return {"kbId": kid, "dataSourceId": ds_id, "ingestionJobId": job}


def poll_sync(kb_id, ds_id, job_id):
    j = BA.get_ingestion_job(
        knowledgeBaseId=kb_id, dataSourceId=ds_id, ingestionJobId=job_id
    )["ingestionJob"]
    status = j["status"]
    return {
        "status": status,
        "done": status in ("COMPLETE", "FAILED"),
        "succeeded": status == "COMPLETE",
    }


def status():
    """Report KB + data-source + latest-ingestion state. Read-only: creates
    and changes nothing, so it is safe to use as a validation step."""
    kid = find_kb()
    if not kid:
        print(f"Knowledge base '{CFG['KB_NAME']}': NOT FOUND "
              "(run this script with no flags to create it).")
        return
    kb = BA.get_knowledge_base(knowledgeBaseId=kid)["knowledgeBase"]
    print(f"Knowledge base '{CFG['KB_NAME']}': {kb['status']} ({kid})")
    if kb.get("failureReasons"):
        print("  failureReasons:", kb["failureReasons"])

    ds_id = find_ds(kid)
    if not ds_id:
        print("Data source: NOT FOUND")
        return
    ds = BA.get_data_source(knowledgeBaseId=kid, dataSourceId=ds_id)["dataSource"]
    print(f"Data source '{ds.get('name', ds_id)}': {ds['status']} ({ds_id})")

    jobs = BA.list_ingestion_jobs(
        knowledgeBaseId=kid, dataSourceId=ds_id,
        sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
        maxResults=1,
    ).get("ingestionJobSummaries", [])
    if not jobs:
        print("Ingestion: no job has run yet (run with --sync).")
        return
    j = jobs[0]
    stats = j.get("statistics", {})
    print(f"Latest ingestion: {j['status']} (started {j.get('startedAt')})")
    if stats:
        print(f"  docs scanned={stats.get('numberOfDocumentsScanned')} "
              f"indexed={stats.get('numberOfNewDocumentsIndexed')} "
              f"modified={stats.get('numberOfModifiedDocumentsIndexed')} "
              f"deleted={stats.get('numberOfDocumentsDeleted')} "
              f"failed={stats.get('numberOfDocumentsFailed')}")


def delete():
    kid = find_kb()
    if kid:
        BA.delete_knowledge_base(knowledgeBaseId=kid)
        print(f"Deleting KB {kid}")
    try:
        IAM.delete_role_policy(RoleName=CFG["KB_ROLE_NAME"], PolicyName="KbAccess")
        IAM.delete_role(RoleName=CFG["KB_ROLE_NAME"])
        print("Deleted KB role")
    except ClientError as e:
        print("role cleanup:", str(e)[:120])


def main(*, delete_kb: bool = False, sync: bool = False, show_status: bool = False):
    """Entry point. Options are explicit parameters (not read from sys.argv) so
    the refresh pipeline can import and call this directly."""
    if show_status:
        status()
        return
    if delete_kb:
        delete()
        return
    kid = find_kb()
    if sync:
        if not kid:
            raise RuntimeError("KB not found; create it first.")
        ingest(kid, find_ds(kid))
        return
    role_arn = ensure_role()
    if not kid:
        kid = create_kb(role_arn)
    ds_id = find_ds(kid) or create_ds(kid)
    ingest(kid, ds_id)
    print(f"\nKnowledge base ready: {kid}. Chat with:  python3 09_chat.py")


if __name__ == "__main__":
    main(delete_kb="--delete" in sys.argv,
         sync="--sync" in sys.argv,
         show_status="--status" in sys.argv)
