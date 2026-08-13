import { defineFunction } from '@aws-amplify/backend';

/**
 * A2A routes handler (Admin-only) for per-space Agent-to-Agent integration:
 * `PUT`/`DELETE /spaces/{spaceId}/a2a-token`, `GET /spaces/{spaceId}/a2a-status`,
 * and `POST /spaces/{spaceId}/a2a/chat`. Own execution role; the Secrets Manager
 * grants (on `devops-observatory/a2a/*`), the manifest S3 read grant, and the
 * config env are wired in `backend.ts`. The A2A call itself is a plain HTTPS
 * request (Bearer token) so no boto3 layer / Python worker is needed.
 */
export const a2a = defineFunction({
  name: 'a2a',
  entry: './handler.ts',
  timeoutSeconds: 130,
});
