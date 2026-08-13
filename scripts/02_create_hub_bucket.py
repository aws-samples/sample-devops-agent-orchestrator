#!/usr/bin/env python3
"""
Step 2 - create the hub S3 bucket (hub account, profile 123456789012).
Private, encrypted, versioned. Idempotent.
"""
from botocore.exceptions import ClientError
from _common import CFG, hub_session


def main():
    s3 = hub_session().client("s3")
    b = CFG["HUB_BUCKET"]
    region = CFG["REGION"]
    try:
        if region == "us-east-1":
            s3.create_bucket(Bucket=b)
        else:
            s3.create_bucket(Bucket=b, CreateBucketConfiguration={"LocationConstraint": region})
        print(f"Created bucket {b}")
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            print(f"Bucket {b} already exists ({code}).")
        else:
            raise
    s3.put_public_access_block(
        Bucket=b,
        PublicAccessBlockConfiguration={
            "BlockPublicAcls": True, "IgnorePublicAcls": True,
            "BlockPublicPolicy": True, "RestrictPublicBuckets": True,
        },
    )
    s3.put_bucket_encryption(
        Bucket=b,
        ServerSideEncryptionConfiguration={
            "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
        },
    )
    s3.put_bucket_versioning(Bucket=b, VersioningConfiguration={"Status": "Enabled"})
    print("Public access blocked, SSE-S3 enabled, versioning enabled.")


if __name__ == "__main__":
    main()
