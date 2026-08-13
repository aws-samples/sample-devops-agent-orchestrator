# boto3 Lambda layer (refresh workers)

The refresh worker Lambdas (webapp task 26) run the hub `scripts/` on the
Python 3.12 managed runtime. The managed runtime's bundled `boto3` may not
include the `devops-agent` client, so a recent `boto3`/`botocore` is supplied
via this layer.

`boto3` is pure Python, so the layer builds with plain `pip` — **no Docker**:

```bash
pip install --target python boto3 botocore
```

This must produce `python/boto3/...` and `python/botocore/...` under this
directory (that is the Lambda layer layout for Python).

- **Amplify build**: `amplify.yml` runs this `pip install` in the backend
  preBuild step before `ampx pipeline-deploy`, so the layer is built in the
  Amplify environment (which has Python 3).
- **Local synth / `ampx sandbox`**: run the `pip install` above once before
  synth so the asset directory is populated.

The built `python/` directory is generated and git-ignored; only this README is
tracked so the asset path always exists.
