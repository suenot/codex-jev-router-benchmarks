<!-- codex-jev-router:start -->
## Subagent model routing

- Keep the continuing parent Codex session on its configured Sol model and reasoning effort. Do not switch its model for individual turns or start a new session solely to route a task.
- Decide whether a subagent is useful before asking the decider for a model. Handle one serial lookup, a short file or log read, a focused claim check, and other small tasks directly with parent tools. Spawn only for independently useful parallel work, isolated substantial context, independent review, or an explicitly requested subagent. Do not call Jev to decide whether Jev or a subagent is needed.
- For each justified Codex subagent spawn, run `node "/Users/suenot/projects/sdvg/codex-jev-router/src/route.mjs" --role=ROLE` with a short, sanitized task summary on stdin. Replace ROLE with the actual agent type. Skip routing only when the user explicitly chooses the subagent model.
- Pass the returned `model` and `reasoning_effort` explicitly to `spawn_agent`. If routing fails, use `gpt-6-sol` with `high` effort.
- Route independent web research and file or log searches only when they pass the delegation gate. Use `default` for web research and `explorer` for read-only local search. Exact lookup may use Luna low; bounded multi-step extraction may use Luna medium; research or diagnosis needing judgment uses Sol high. Direct tool calls by the parent keep the parent model.
- Use Sol with `ultra` effort when the router identifies an exceptionally difficult task or after Sol substantively fails. For a retry, start the routing summary with `[codex-router:sol-failed]` and describe the observed failure.
- Do not put credentials or private source text in summaries; the selected decider receives them. Prefer the parent when a child would duplicate setup, context, or verification work.
<!-- codex-jev-router:end -->
