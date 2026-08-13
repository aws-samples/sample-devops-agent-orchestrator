import { defineFunction } from '@aws-amplify/backend';

/**
 * `POST /spaces` handler (Admin-only create agent space). Own execution role;
 * the manifest S3 read grant, the `lambda:InvokeFunction` grant on the Python
 * worker, and the config env are wired in `backend.ts`.
 */
export const createSpace = defineFunction({
  name: 'create-space',
  entry: './handler.ts',
});
