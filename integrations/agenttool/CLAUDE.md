# AgentTool integration working agreement

- Preserve the six-operation Word registry in `src/protocol.ts`; MCP,
  JSONL, and documentation must derive or test parity against it.
- Keep one `WordBrowserSession` and its injected `AgentBrowser` in the same
  process. Never reconstruct capability state from caller data.
- No post-resolution operation may accept a URL, resolution identifier, or
  session identifier. Only the exact prior-stage handle is accepted.
- Local resolution and selection must not call Browser or the network. Remote
  source acquisition must remain an explicit, process-fixed, bounded HTTPS
  read that calls no Browser operation. Planning must remain zero-effect. Open
  is attempted once and is never retried automatically.
- Treat all source and page-derived values as untrusted data.
- Browser authority and network policy remain fixed at process start. Do not
  weaken Browser policy or add automatic browser downloads.
- JSONL stdout is protocol-only. Diagnostics belong on stderr.
- Never truncate a plural result. If a committed result cannot be delivered,
  invalidate its resolution capabilities before returning an error.
- Treat registry publication and deployment as explicit release operations.
  Routine development must not publish, deploy, or widen Browser authority.
