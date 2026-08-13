# Lambda functions

This directory is the home for the API-route Lambda handlers. Each function is a
subfolder with a `resource.ts` (defined via `defineFunction`) and a `handler.ts`.

As of Task 3 the API-layer **shell** is in place: every planned function exists
as an authenticated stub returning a `NOT_IMPLEMENTED` (501) placeholder, wired
behind the HTTP API Cognito JWT authorizer (and the streaming Function URL for
`chat`). Later tasks (4–10) replace the stub bodies with real logic.

Cross-cutting helpers live in `shared/`:

- `errors.ts` — typed API errors (`AuthenticationRequiredError`,
  `InsufficientPermissionsError`, `NotImplementedError`, …).
- `http.ts` — HTTP API event/result aliases and JSON success/error response
  helpers (`withErrorHandling`, `jsonResponse`, `errorResponse`).
- `authz.ts` — verified-claims extraction and the reusable `assertAdmin` guard
  used by the Admin-only route stubs.
- `functionUrlAuth.ts` — auth enforcement for the streaming `/chat` Function URL
  (which sits outside the HTTP API authorizer).

The HTTP API, JWT authorizer, streaming Function URL, and per-route IAM roles
are wired in `../backend.ts`; the CDK helper constructs live in `../api/`.

Planned handlers (see design.md "Backend API"):

| Function        | Route                         | Task |
| --------------- | ----------------------------- | ---- |
| `summary`       | `GET /summary`                | 4.1  |
| `spaces`        | `GET /spaces`                 | 4.2  |
| `dashboard`     | `GET /dashboard`              | 4.3  |
| `context`       | `GET /context`, `PUT /context`| 5.2  |
| `graph`         | `GET /graph`                  | 8    |
| `chat`          | `POST /chat` (Function URL, streaming) | 9 |
| `refresh`       | `POST /refresh`               | 10.2 |
| `refreshStatus` | `GET /refresh/status`         | 10.2 |

Guidelines for later tasks:

- Handlers share DTO contracts from `@devops-observatory/shared-types`.
- Each handler gets a **least-privilege IAM role** (design "Components and
  Interfaces"): S3 read (or read+write for `/context`) on specific keys,
  `neptune-graph:ExecuteQuery` for `/graph`, `bedrock:InvokeModel*` + KB
  retrieve for `/chat`, `states:StartExecution` for `/refresh`.
- No AWS credentials ever reach the browser; all AWS access is server-side.
- Backend config (bucket, graph id, KB id, region) is injected as environment
  variables — never hardcode secrets. See `../../.env.example`.
