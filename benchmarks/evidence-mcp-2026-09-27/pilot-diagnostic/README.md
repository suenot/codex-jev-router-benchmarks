# Diagnostic pilot (excluded from the holdout)

On 2026-09-27, one noisy Django log task (`dj-pagination-incident`) was run once in each arm with one continuing `gpt-6-sol` `xhigh` Codex session and no subagents. The local Laya 0.3.20 server used the `typed-decisions` checkpoint on `127.0.0.1:8000`. This run checked the end-to-end harness before the full study; it is not a savings estimate.

| Arm | Estimated API cost | Answer | Initial strict grade |
| --- | ---: | --- | --- |
| Stock Codex | $0.0545924 | Correct method | Pass |
| Deterministic MCP | $0.0524740 | Correct method | Pass |
| Local Laya MCP | $0.0332788 | Correct method | Fail |

Laya's answer cited recovered traceback lines 360 and 730, the terminal failure lines 901 and 902, and the source definition. The initial grader required warning line 620 specifically and rejected the answer despite its equivalent evidence at line 730. We changed the **general rule for every log task** to require the correct answer, both terminal lines, the source definition, and one valid citation for each of the first two recovered attempts (`120` or `360`, and `620` or `730`). Under that rule, all three pilot answers pass. The original recorded grade remains in [results.json](results.json); the [runner library](../../../scripts/evidence-lib.mjs) contains the revised rule and its test.

Because this task was inspected, it was moved to the tuning set. A first replacement was exercised in a later [format diagnostic](../diagnostic-format/README.md); all exposed read tasks were then replaced before final runs. The [holdout manifest](../manifest.json) records the frozen task set. The raw pilot traces are kept beside the result file. No pilot run contributes to the final cost or quality comparison.
