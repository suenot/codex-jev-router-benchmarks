# Local evidence MCP benchmark

Status: **complete, audited holdout**.

Runs: 144/144; edit attempts replayed: 36; eligible Laya searches: 14; genuine local Laya selection: yes.

Intervention runs with no MCP search, by task kind: exact=24, log=3, multi=24, edit=24. Nonuse is a valid measured outcome in every arm; log and multi-file tasks are preregistered as most likely to benefit.

The three arms use one Codex `gpt-6-sol` root at `xhigh`; child agents are disabled. The baseline has no MCP and is instructed to use ordinary local commands. Intervention arms have the local MCP and are instructed to prefer it for broad or noisy searches, with deterministic or Laya selection (`typed-decisions` at loopback `127.0.0.1:8000`). The comparison measures tool availability together with this instruction; it does not show that Codex would discover and use the MCP unaided. Every attempt, including retries, contributes its Codex input, cached input, cache writes, and output tokens to the estimated API price. Local CPU/electricity, other charges, and subscription billing are excluded.

The four incident logs are deterministic noisy overlays on two pinned public source repositories; they are not production logs. The final holdout task set was frozen after the excluded diagnostics and before the complete 144-run comparison. Tuning tasks are disjoint. Relative uncertainty uses task-cluster bootstrap resampling (10,000 draws) over paired repetitions.

Two earlier diagnostics are excluded: a [three-arm pilot](pilot-diagnostic/README.md) exposed an overstrict log-citation rule; an [interrupted 34-run format diagnostic](diagnostic-format/README.md) exposed overstrict answer formatting. Every read task shown in either diagnostic was replaced, while the four unrun edit tasks were retained. The final manifest and grader were frozen before any replacement task was run. These revisions mean this is a frozen **final** holdout after diagnostic feedback, not an untouched first-pass preregistration.

Supplemental post-run integrity: [post-run-integrity.json](post-run-integrity.json) binds this results file and the MCP wrapper to SHA-256 digests. The evidence implementation was **not hashed at run time**. Its first post-run digest was `d7eb20634e92b40350dd6f46ea802edae9f0386df8d62b8594c8d5fd5f28ffe3`; the current post-change digest is `12c16294f892bbe1509bdc18311de2b710aa3098b6dbfc502cfe9c6f20ca0e4d`. Neither digest proves the implementation bytes used during model runs.

After the measured run, the main MCP implementation was hardened to exclude hidden paths such as `.zshrc` and to stop using `rg --hidden`. A targeted post-change preflight on the `dj-signing-incident` fixture returned six excerpts from 16 candidates and excluded a matching hidden `.zshrc`; the full economic comparison was **not** rerun after this change.

| Task kind | Pair | Strict passes | Control USD | Candidate USD | Saving | 95% CI | Quality | Cost gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| all | local deterministic vs stock | 48/45 | $2.060703 | $1.653006 | 19.8% | 4.4% to 33.3% | pass | pass |
| all | local Laya vs stock | 48/45 | $2.060703 | $1.759781 | 14.6% | -0.1% to 28.7% | pass | fail |
| all | local Laya vs deterministic | 48/48 | $1.653006 | $1.759781 | -6.5% | -19.5% to 6.1% | pass | fail |
| eligible | local deterministic vs stock | 24/21 | $1.097944 | $0.769878 | 29.9% | 5.7% to 46.0% | pass | pass |
| eligible | local Laya vs stock | 24/21 | $1.097944 | $0.837782 | 23.7% | 0.2% to 40.2% | pass | pass |
| eligible | local Laya vs deterministic | 24/24 | $0.769878 | $0.837782 | -8.8% | -30.6% to 5.7% | pass | fail |
| exact | local deterministic vs stock | 12/12 | $0.227720 | $0.186704 | 18.0% | -8.1% to 34.5% | pass | fail |
| exact | local Laya vs stock | 12/12 | $0.227720 | $0.173878 | 23.6% | -5.4% to 46.5% | pass | fail |
| exact | local Laya vs deterministic | 12/12 | $0.186704 | $0.173878 | 6.9% | -6.4% to 19.5% | pass | fail |
| log | local deterministic vs stock | 12/9 | $0.771064 | $0.450921 | 41.5% | 17.4% to 56.8% | pass | pass |
| log | local Laya vs stock | 12/9 | $0.771064 | $0.492150 | 36.2% | 18.8% to 51.6% | pass | pass |
| log | local Laya vs deterministic | 12/12 | $0.450921 | $0.492150 | -9.1% | -49.6% to 10.4% | pass | fail |
| multi | local deterministic vs stock | 12/12 | $0.326880 | $0.318958 | 2.4% | -12.0% to 20.3% | pass | fail |
| multi | local Laya vs stock | 12/12 | $0.326880 | $0.345632 | -5.7% | -32.8% to 18.5% | pass | fail |
| multi | local Laya vs deterministic | 12/12 | $0.318958 | $0.345632 | -8.4% | -18.5% to 1.5% | pass | fail |
| edit | local deterministic vs stock | 12/12 | $0.735039 | $0.696423 | 5.3% | -11.3% to 20.3% | pass | fail |
| edit | local Laya vs stock | 12/12 | $0.735039 | $0.748121 | -1.8% | -15.0% to 9.5% | pass | fail |
| edit | local Laya vs deterministic | 12/12 | $0.696423 | $0.748121 | -7.4% | -28.5% to 16.1% | pass | fail |

## Individual final tasks

Each cost is the sum of three repetitions, including retries. Pass counts are strict final grades. Savings compare deterministic MCP with stock Codex for the same task; task-level differences have only three paired repetitions and are descriptive.

| Task | Kind | Stock USD (pass) | Deterministic USD (pass) | Laya USD (pass) | Deterministic saving |
| --- | --- | ---: | ---: | ---: | ---: |
| `dj-b64-decode-symbol` | exact | $0.037328 (3/3) | $0.046186 (3/3) | $0.040650 (3/3) | -23.7% |
| `dj-page-has-previous-symbol` | exact | $0.083098 (3/3) | $0.050272 (3/3) | $0.037558 (3/3) | 39.5% |
| `pt-resolve-package-symbol` | exact | $0.048315 (3/3) | $0.043980 (3/3) | $0.049616 (3/3) | 9.0% |
| `pt-safe-exists-symbol` | exact | $0.058978 (3/3) | $0.046267 (3/3) | $0.046054 (3/3) | 21.6% |
| `dj-signing-incident` | log | $0.238622 (3/3) | $0.096540 (3/3) | $0.167725 (3/3) | 59.5% |
| `dj-paginator-page-incident` | log | $0.232686 (2/3) | $0.106927 (3/3) | $0.095150 (3/3) | 54.0% |
| `pt-collect-report-incident` | log | $0.160376 (2/3) | $0.119217 (3/3) | $0.107378 (3/3) | 25.7% |
| `pt-locate-config-incident` | log | $0.139380 (2/3) | $0.128236 (3/3) | $0.121897 (3/3) | 8.0% |
| `dj-random-storage-suffix` | multi | $0.091850 (3/3) | $0.066626 (3/3) | $0.065683 (3/3) | 27.5% |
| `dj-redirect-iri-conversion` | multi | $0.061075 (3/3) | $0.067697 (3/3) | $0.077339 (3/3) | -10.8% |
| `pt-config-root-discovery` | multi | $0.094888 (3/3) | $0.095317 (3/3) | $0.093878 (3/3) | -0.5% |
| `pt-test-module-import` | multi | $0.079067 (3/3) | $0.089318 (3/3) | $0.108733 (3/3) | -13.0% |
| `dj-filename-fix` | edit | $0.161320 (3/3) | $0.169673 (3/3) | $0.139614 (3/3) | -5.2% |
| `dj-slugify-fix` | edit | $0.136366 (3/3) | $0.159108 (3/3) | $0.136124 (3/3) | -16.7% |
| `pt-ansi-fix` | edit | $0.264378 (3/3) | $0.197102 (3/3) | $0.258058 (3/3) | 25.4% |
| `pt-pattern-fix` | edit | $0.172975 (3/3) | $0.170540 (3/3) | $0.214326 (3/3) | 1.4% |

Recommendation gate for deterministic evidence (all-task quality plus eligible-task cost): **PASS**. Laya default gate (same quality, extra eligible-task cost saving, genuine local selection): **FAIL**.

Interpretation: deterministic MCP saved **29.9%** estimated Codex API cost on the preregistered log and multi-file tasks (task-cluster 95% CI 5.7% to 46.0%) and **19.8%** across all tasks. The measurable signal came from noisy logs (41.5% saved); the MCP was unused in 24 multi-file intervention runs, so that category does not demonstrate retrieval benefit. Local Laya made 14 genuine eligible selections but cost **8.8% more** than deterministic selection on eligible tasks and does not pass the default gate.

Use deterministic evidence selection selectively for noisy log investigations. These four synthetic log overlays on two real pinned repositories do not establish a production-wide savings rate. Exact lookups and bounded edits did not meet their separate 10% confidence gate; the sessions were fresh, so continuing-dialog cache effects remain unmeasured.
