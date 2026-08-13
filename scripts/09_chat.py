#!/usr/bin/env python3
"""
Step 9 - chat application over the MANAGED knowledge base.

Managed KBs are queried with AgenticRetrieveStream (agentic RAG): it plans a
retrieval strategy, runs multiple retrieval passes, and streams back a
citation-backed answer synthesized by the model. Keeps conversation history for
multi-turn follow-ups.

  python3 09_chat.py                       # interactive REPL
  python3 09_chat.py "your question"       # one-shot

Run with hub credentials (profile 123456789012).
"""
import sys
from _common import CFG, hub_session

RT = hub_session().client("bedrock-agent-runtime")
BA = hub_session().client("bedrock-agent")


def kb_id():
    for p in BA.get_paginator("list_knowledge_bases").paginate():
        for kb in p["knowledgeBaseSummaries"]:
            if kb["name"] == CFG["KB_NAME"]:
                return kb["knowledgeBaseId"]
    raise SystemExit("KB not found - run step 8 first.")


def ask(kid, messages):
    """Send conversation `messages`, stream the answer, return (answer, sources)."""
    resp = RT.agentic_retrieve_stream(
        agenticRetrieveConfiguration={
            "foundationModelType": "CUSTOM",
            "foundationModelConfiguration": {
                "type": "BEDROCK_FOUNDATION_MODEL",
                "bedrockFoundationModelConfiguration": {
                    "modelConfiguration": {"modelArn": CFG["KB_CHAT_MODEL_ARN"]}
                },
            },
        },
        messages=messages,
        retrievers=[{"configuration": {"knowledgeBase": {"knowledgeBaseId": kid}}}],
        generateResponse=True,
    )
    answer, sources, streamed = "", [], False
    for event in resp["stream"]:
        if "responseEvent" in event:            # streaming answer chunks
            chunk = event["responseEvent"].get("text", "")
            answer += chunk
            print(chunk, end="", flush=True)
            streamed = True
        elif "result" in event:                 # final results + citations
            res = event["result"]
            if not answer:
                answer = res.get("generatedResponse", {}).get("answer", "")
            for r in res.get("results", []):
                md = r.get("metadata", {}) or {}
                uri = md.get("_source_uri") or md.get("x-amz-bedrock-kb-source-uri") \
                    or r.get("sourceRetriever", {}).get("identifier")
                if uri and uri not in sources:
                    sources.append(uri)
        else:  # surface any exception event
            for k, v in event.items():
                if k.endswith("Exception"):
                    raise SystemExit(f"{k}: {v.get('message')}")
    if streamed:
        print()
    return answer, sources


def main():
    kid = kb_id()
    if len(sys.argv) > 1:
        _, sources = ask(kid, [{"role": "user", "content": {"text": " ".join(sys.argv[1:])}}])
        if sources:
            print("\nSources: " + ", ".join(sources))
        return
    print(f"DevOps Agent KB chat ({CFG['KB_NAME']}). Ctrl-C or 'exit' to quit.\n")
    history = []
    while True:
        try:
            q = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if q.lower() in ("exit", "quit"):
            break
        if not q:
            continue
        history.append({"role": "user", "content": {"text": q}})
        print("kb> ", end="", flush=True)
        answer, sources = ask(kid, history)
        history.append({"role": "assistant", "content": {"text": answer}})
        if sources:
            print("    sources: " + ", ".join(sources))
        print()


if __name__ == "__main__":
    main()
