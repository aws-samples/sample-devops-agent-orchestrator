import { answerChatOnce, buildMessages, composeSystemPrompt, parseChatRequest } from '../shared/bedrockChat';
import { resolveLastSyncDate } from '../shared/aggregation';
import { getCaller } from '../shared/authz';
import { appendMessages, getSettings } from '../shared/chatHistory';
import { buildGraphResponse } from '../shared/graphEnrichment';
import { summarizeTopology } from '../shared/graphContext';
import { loadBusinessContext, loadManifest } from '../shared/hubData';
import { loadGraph } from '../shared/neptuneGraph';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `POST /chat` handler — Bedrock managed knowledge-base chat proxy with memory.
 *
 * Served over the JWT-authorized HTTP API (NOT a public streaming Lambda
 * Function URL): this deployment's environment blocks unauthenticated
 * (`AuthType=NONE`) Function URLs, so chat uses the same Cognito JWT authorizer
 * as every other route. Authentication is therefore enforced by API Gateway
 * before this handler runs (Requirements 1.2, 2.6, 8.8) — no in-handler token
 * verification is needed.
 *
 * Flow:
 *   1. Validate the question is 1–1,000 chars and normalize prior turns for
 *      multi-turn context (Requirements 8.1, 8.5, 8.9); a rejection becomes the
 *      standard 400 error envelope via {@link withErrorHandling}, with no
 *      Bedrock call.
 *   2. Call {@link answerChatOnce} to get the full synthesized answer and the
 *      deduplicated citation set (empty = no sources cited; Requirements
 *      8.2–8.4). An upstream failure/timeout is surfaced as a 502 error
 *      envelope, leaving the caller's conversation intact (Requirement 8.7).
 *   3. Persist the question + answer to the caller's own S3-backed chat memory,
 *      pruned to the admin-configured retention window on write. This is
 *      BEST-EFFORT — a storage failure is logged and swallowed so it never
 *      fails the answer.
 *
 * The answer is returned as a single JSON {@link import('@devops-observatory/shared-types').ChatResponse}.
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  const caller = getCaller(event);
  const { message, history } = parseChatRequest(event.body, event.isBase64Encoded);

  // Ground the answer in three sources (Requirement 15.1): the managed KB (via
  // AgenticRetrieve), the admin business context (org system prompt), and the
  // Neptune topology (GraphRAG). Business context, manifest, and graph are
  // loaded in parallel and each fails soft — if the graph is unavailable the
  // answer degrades to KB-only rather than failing (Requirement 15.4).
  const [context, graphLoad, manifestLoad] = await Promise.all([
    loadBusinessContext(),
    loadGraph(),
    loadManifest(),
  ]);

  let systemPrompt = composeSystemPrompt(context?.orgSystemPrompt);
  if (graphLoad.status === 'ok') {
    const graph = buildGraphResponse(graphLoad.nodes, graphLoad.edges, context);
    const lastSyncDate =
      manifestLoad.status === 'ok' ? resolveLastSyncDate(manifestLoad.manifest) : undefined;
    const facts = summarizeTopology(graph, { lastSyncDate });
    if (facts.length > 0) {
      systemPrompt += `\n\nTOPOLOGY FACTS (read-only reference; use alongside the knowledge base and cite freshness):\n${facts}`;
    }
  }

  const messages = buildMessages(message, history, systemPrompt);
  // Keep the answer timeout below the HTTP API's 30s integration timeout so a
  // slow knowledge base returns a clean 502 rather than an API Gateway 504.
  const { answer, citations } = await answerChatOnce(messages, { timeoutMs: 27_000 });

  // Persist this turn as chat memory (best-effort). A failure here must never
  // fail the answer the user just received.
  try {
    const { chatHistoryRetentionDays } = await getSettings();
    await appendMessages(
      caller.userId,
      [
        { role: 'user', content: message },
        { role: 'assistant', content: answer, citations },
      ],
      chatHistoryRetentionDays,
    );
  } catch (err) {
    console.error('[chat] failed to persist chat memory:', err);
  }

  return jsonResponse({ answer, citations });
});
