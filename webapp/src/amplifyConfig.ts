/**
 * Amplify client bootstrap.
 *
 * Amplify Gen 2 generates `amplify_outputs.json` at the project root when you
 * run `ampx sandbox` or deploy a pipeline. It contains the Cognito user pool,
 * API endpoints, and other resource references the SPA needs. It is
 * environment-specific and git-ignored — never commit it.
 *
 * This module loads that file (when present) and configures the Amplify client.
 * The auth resource is a placeholder scaffold in Task 1; Task 2 fleshes out the
 * Cognito user pool + Executive/Admin groups, and later tasks add API config.
 *
 * Credential safety (design): the browser never holds AWS credentials. The SPA
 * only holds a Cognito session (JWT) and talks to the API layer.
 */
import { Amplify } from 'aws-amplify';

/**
 * Retained raw Gen 2 outputs (amplify_outputs.json). `Amplify.getConfig()`
 * parses the file into its runtime `ResourcesConfig` and intentionally does NOT
 * surface the top-level `custom` section, so the backend's `addOutput({ custom })`
 * values (apiBaseUrl, chatStreamUrl) are invisible via `getConfig()`. We keep
 * the raw outputs here and expose `custom` to the API clients instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rawOutputs: Record<string, any> | undefined;

export function configureAmplify(): void {
  // Loaded lazily so a missing outputs file (e.g. before the first sandbox
  // run) does not crash local dev. Populated once `ampx sandbox` has run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outputs: Record<string, any> | undefined;
  try {
    // Vite resolves this glob at build time; the file is git-ignored.
    const modules = import.meta.glob('../amplify_outputs.json', {
      eager: true,
    }) as Record<string, { default: Record<string, unknown> }>;
    const entry = Object.values(modules)[0];
    outputs = entry?.default;
  } catch {
    outputs = undefined;
  }

  rawOutputs = outputs;

  if (outputs) {
    Amplify.configure(outputs);
  } else {
    // No outputs yet — run `npm run sandbox` to generate amplify_outputs.json.
    console.warn(
      '[amplify] amplify_outputs.json not found. Run `npm run sandbox` to provision a dev backend.',
    );
  }
}

/**
 * The top-level `custom` section from amplify_outputs.json (populated by the
 * backend's `addOutput`), which `Amplify.getConfig()` does not expose. Returns
 * undefined until {@link configureAmplify} has run, and only when an outputs
 * file was present at build time.
 */
export function getCustomOutputs(): Record<string, unknown> | undefined {
  const custom = rawOutputs?.custom;
  return custom && typeof custom === 'object' ? (custom as Record<string, unknown>) : undefined;
}
