# syntax=docker/dockerfile:1
#
# Refresh-pipeline container image (webapp task 10.1).
#
# Packages the existing hub scripts (/scripts) + boto3 and runs the ordered
# refresh stages (collect -> transform -> KB sync -> graph reset+reload) via
# pipeline_entrypoint.py. The image is launched as an ECS Fargate task by the
# refresh Step Functions state machine (see webapp/amplify/refresh/resource.ts).
#
# Build context is the repo root (so it can COPY config.env + scripts/):
#   docker build -f pipeline/Dockerfile -t devops-observatory-refresh .
# The Amplify/CDK ContainerImage.fromAsset build uses the same context + file.

# Public ECR mirror of the official python image (avoids Docker Hub rate limits
# in the AWS build environment).
FROM public.ecr.aws/docker/library/python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Make _common.py use the ECS task role instead of named AWS profiles.
    PIPELINE_CREDENTIALS_MODE=default

WORKDIR /app

# Install pinned dependencies first for better layer caching.
COPY pipeline/requirements.txt /app/pipeline/requirements.txt
RUN pip install --no-cache-dir -r /app/pipeline/requirements.txt

# Shared, non-secret hub config (bucket / graph / KB ids) + the pipeline scripts.
# config.env sits at the parent of scripts/ exactly as _common.py expects.
COPY config.env /app/config.env
COPY scripts/ /app/scripts/

# Drop root. The task only reads its own code and calls AWS APIs - every output
# goes to S3, nothing is written to the image filesystem - so a non-root user
# with no write access to /app is sufficient.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin pipeline
USER 10001

# Running from the scripts dir lets each script resolve `from _common import ...`.
WORKDIR /app/scripts
ENTRYPOINT ["python", "pipeline_entrypoint.py"]
