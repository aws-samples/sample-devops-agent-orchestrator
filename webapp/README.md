# DevOps Observatory Web App

An authenticated executive SPA (AWS Amplify Gen 2 + React + TypeScript) over the
existing DevOps Agent hub backend (S3 hub bucket, Neptune Analytics graph, and
Bedrock managed knowledge base in account `123456789012`, `us-east-1`).

> **Status:** Feature-complete (tasks 1–19). SPA, Cognito auth, the serverless
> API layer, graph enrichment, admin context/refresh, and Amplify hosting +
> CI/CD are all in place. See the [operations runbook](./OPERATIONS.md) to deploy.

## Project structure

```
webapp/
├── amplify/                      # Amplify Gen 2 backend (CDK-based TypeScript)
│   ├── backend.ts                # defineBackend entry (auth wired; API/functions TODO)
│   ├── auth/resource.ts          # Cognito user pool placeholder (Task 2 fills groups)
│   ├── functions/                # Lambda handler home (placeholder; Tasks 4–10)
│   └── tsconfig.json
├── packages/
│   └── shared-types/             # Shared DTO/interface contracts (SPA + backend)
│       └── src/index.ts
├── src/                          # React SPA
│   ├── main.tsx                  # entry + Amplify bootstrap
│   ├── App.tsx                   # minimal shell (replaced by later tasks)
│   ├── amplifyConfig.ts          # loads amplify_outputs.json, Amplify.configure
│   └── vite-env.d.ts
├── index.html
├── vite.config.ts
├── tsconfig*.json                # project-referenced, strict mode
├── .env.example                  # non-secret config mapped to repo-root config.env
└── package.json                  # npm workspace root (shared-types)
```

## Prerequisites

- Node.js 18+ and npm 9+ (npm workspaces).
- For backend provisioning/deploy: AWS credentials for the hub account and the
  Amplify CLI (`ampx`, provided by `@aws-amplify/backend-cli` as a dev
  dependency — no global install needed).

## Install

```bash
cd webapp
npm install
```

This installs the SPA and backend dependencies and links the local
`@devops-observatory/shared-types` workspace package.

## Local development

```bash
npm run dev        # Vite dev server at http://localhost:5173
```

To run a personal cloud backend (Cognito, API, functions) for local testing,
start an Amplify sandbox in a second terminal. It generates
`amplify_outputs.json` (git-ignored) that the SPA reads on startup:

```bash
npm run sandbox        # ampx sandbox — provisions/updates a dev backend
npm run sandbox:delete # tears the sandbox down
```

## Build & type-check

```bash
npm run typecheck  # tsc -b across SPA, backend, and shared-types (no emit)
npm run build      # type-check + Vite production build to dist/
npm run preview    # serve the production build locally
```

## Deploy

Hosting + CI/CD run on AWS Amplify Gen 2. The repo-root
[`amplify.yml`](../amplify.yml) build spec (monorepo form, `appRoot: webapp`)
deploys the CDK backend and builds the SPA on every push to the connected
branch, serving the app at a single entry-point URL. See the
[operations runbook](./OPERATIONS.md) for first-time hosting setup, environment
variables, and rollback.

For pipeline builds the script is:

```bash
npm run deploy     # ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID
```

## Available npm scripts

| Script                  | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `npm run dev`           | Vite dev server (SPA).                               |
| `npm run build`         | Type-check (`tsc -b`) then Vite production build.    |
| `npm run preview`       | Serve the production build locally.                  |
| `npm run typecheck`     | Type-check all projects with no emit.                |
| `npm run sandbox`       | Provision/update a personal Amplify dev backend.     |
| `npm run sandbox:delete`| Delete the personal Amplify dev backend.             |
| `npm run deploy`        | Pipeline deploy (used by CI/CD via `amplify.yml`).   |

## Configuration → hub backend mapping

The app reads the already-deployed hub backend. Non-secret resource identifiers
are documented in [`.env.example`](./.env.example) and map to the repo-root
[`config.env`](../config.env) (the source of truth):

| `.env` key              | `config.env` key    | Value                                        |
| ----------------------- | ------------------- | -------------------------------------------- |
| `HUB_REGION`            | `REGION`            | `us-east-1`                                  |
| `HUB_ACCOUNT_ID`        | `HUB_ACCOUNT_ID`    | `123456789012`                               |
| `HUB_BUCKET`            | `HUB_BUCKET`        | `devops-agent-hub-123456789012-us-east-1`    |
| `NEPTUNE_GRAPH_NAME`    | `NEPTUNE_GRAPH_NAME`| `devops-agent-topology`                      |
| `KB_NAME`               | `KB_NAME`           | `devops-agent-kb`                            |

Actual values are injected at deploy time as Lambda environment variables. Set
them as Amplify Hosting environment variables per branch; the full list
(including `APP_ORIGIN` for CORS and the optional `MGMT_ROLE_ARN`) is documented
in the [operations runbook](./OPERATIONS.md).

## Credential safety

Per the design: the browser never holds AWS credentials. The SPA holds only a
Cognito session (JWT) and talks exclusively to the API layer; all AWS access
(S3, Neptune, Bedrock) happens server-side in Lambda handlers with
least-privilege IAM roles. Never commit `.env` or `amplify_outputs.json`.
