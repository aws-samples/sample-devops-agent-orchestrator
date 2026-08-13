import type { ChatCitation, ChatRequest, ChatResponse } from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * `POST /chat` client (consumed by the Chat_UI in `views/ChatView.tsx`).
 *
 * Chat is served over the JWT-authorized HTTP API (non-streaming), NOT a public
 * streaming Function URL — this deployment's environment blocks unauthenticated
 * (`AuthType=NONE`) Function URLs, so chat uses the same authorized JSON path as
 * every other route (`client.ts`). The full synthesized answer and its
 * deduplicated citation set arrive in one JSON {@link ChatResponse}.
 *
 * To keep the view unchanged, this preserves the previous callback-based
 * signature: on success it delivers the whole answer via a single `onChunk`,
 * then `onCitations`, then `onDone`. A non-2xx response or transport failure is
 * thrown as an {@link import('./client').ApiRequestError}, which the view
 * catches to flag only the affected turn while preserving prior turns
 * (Requirement 8.7).
 *
 * Credential safety (design): the browser never holds AWS credentials — the
 * request carries only the caller's Cognito access token (attached by
 * `apiFetch`), and all AWS access happens server-side behind the API's JWT
 * authorizer (Requirement 8.8).
 */

/** Callbacks invoked as the answer is delivered. */
export interface StreamChatHandlers {
  /** The answer text (delivered in full for the non-streaming API) (Req 8.2). */
  onChunk(text: string): void;
  /** The deduplicated cited-source set; empty = no sources cited (8.3, 8.4). */
  onCitations(citations: ChatCitation[]): void;
  /** An error message; the conversation is preserved (8.7). */
  onError(message: string): void;
  /** The answer was delivered successfully. */
  onDone(): void;
}

/** Options for {@link streamChat} (an abort signal to cancel an in-flight request). */
export interface StreamChatOptions {
  signal?: AbortSignal;
}

/**
 * POST a chat request and deliver the answer via `handlers`. Resolves when the
 * answer has been delivered. A non-2xx response (401 UNAUTHENTICATED / 400
 * VALIDATION / 502 UPSTREAM_UNAVAILABLE) or a network failure is thrown as an
 * {@link import('./client').ApiRequestError} so the caller keeps its prior
 * conversation (Requirement 8.7).
 */
export async function streamChat(
  request: ChatRequest,
  handlers: StreamChatHandlers,
  opts: StreamChatOptions = {},
): Promise<void> {
  const response = await apiFetch<ChatResponse>('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: opts.signal,
  });

  handlers.onChunk(typeof response.answer === 'string' ? response.answer : '');
  handlers.onCitations(Array.isArray(response.citations) ? response.citations : []);
  handlers.onDone();
}
