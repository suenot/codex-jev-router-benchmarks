# Mixed four-arm benchmark audit

Runs: 72/72; three repeats and all four arms are required for release decisions.

Costs include every recorded attempt, parent and child Codex sessions, cached and uncached input, output, cache writes, and Jev decisions where made. [OpenAI Standard short-context rates](https://developers.openai.com/api/docs/pricing) and [TypeSafe's published $0.042/M Jev input rate](https://typesafe.ai/blog/introducing-system-one-models-and-jev) are assumptions; TypeSafe lists Jev output free. Possible tool fees, other charges, and subscription billing are not measured.

This public synthetic fixture contains offline source research. It does not measure live web research, continuing terminal threads or their context cache, production billing, or a broad production task distribution.

## All complete blocks

| Arm | Strict passes | Total USD | Change vs single | Median seconds | Retries | Child sessions | Jev decisions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 18/18 | $0.786760 | +133.1% | 36.00 | 1 | 19 | 0 |
| jev_routed_child | 18/18 | $0.572820 | +69.7% | 30.10 | 0 | 18 | 18 |
| optional_delegation | 18/18 | $0.346462 | +2.7% | 19.25 | 0 | 0 | 0 |
| single_sol_xhigh | 18/18 | $0.337455 | +0.0% | 17.48 | 0 | 0 | 0 |

## bounded_extraction

Complete blocks: 3

| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 3/3 | $0.102051 | $0.031551–$0.038564 | 30.86 | 0 |
| jev_routed_child | 3/3 | $0.063606 | $0.019033–$0.024501 | 28.02 | 0 |
| optional_delegation | 3/3 | $0.045466 | $0.014579–$0.015835 | 16.98 | 0 |
| single_sol_xhigh | 3/3 | $0.063610 | $0.015801–$0.031808 | 15.77 | 0 |

Jev child routes: gpt-6-luna/medium × 3.

Optional policy vs single Sol xhigh gate: PASS; quality=PASS over 3 successful control blocks, cost=PASS.

Jev child vs fixed Sol high child gate: PASS; quality=PASS over 3 successful control blocks, cost=PASS.

Cheaper profile for an already justified child on this fixture task: YES.

## code_edit

Complete blocks: 3

| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 3/3 | $0.153716 | $0.046663–$0.056928 | 45.64 | 0 |
| jev_routed_child | 3/3 | $0.136176 | $0.043420–$0.047684 | 39.05 | 0 |
| optional_delegation | 3/3 | $0.085488 | $0.026749–$0.031862 | 31.73 | 0 |
| single_sol_xhigh | 3/3 | $0.074519 | $0.021991–$0.028157 | 28.55 | 0 |

Jev child routes: gpt-6-sol/high × 3.

Optional policy vs single Sol xhigh gate: FAIL; quality=PASS over 3 successful control blocks, cost=FAIL or unknown.

Jev child vs fixed Sol high child gate: NO ROUTE CHANGE; quality=PASS over 3 successful control blocks, cost=PASS.

Cheaper profile for an already justified child on this fixture task: NO; Jev selected the fixed Sol high profile, so numeric price differences are same-model variation.

## focused_judgment

Complete blocks: 3

| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 3/3 | $0.145731 | $0.031309–$0.076298 | 40.41 | 1 |
| jev_routed_child | 3/3 | $0.096284 | $0.031699–$0.032485 | 29.45 | 0 |
| optional_delegation | 3/3 | $0.051301 | $0.014725–$0.020934 | 17.37 | 0 |
| single_sol_xhigh | 3/3 | $0.043242 | $0.011867–$0.019020 | 14.44 | 0 |

Jev child routes: gpt-6-sol/high × 3.

Optional policy vs single Sol xhigh gate: FAIL; quality=PASS over 3 successful control blocks, cost=FAIL or unknown.

Jev child vs fixed Sol high child gate: NO ROUTE CHANGE; quality=PASS over 3 successful control blocks, cost=PASS.

Cheaper profile for an already justified child on this fixture task: NO; Jev selected the fixed Sol high profile, so numeric price differences are same-model variation.

## log_lookup

Complete blocks: 3

| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 3/3 | $0.098821 | $0.031156–$0.036196 | 29.23 | 0 |
| jev_routed_child | 3/3 | $0.077505 | $0.023657–$0.029048 | 26.29 | 0 |
| optional_delegation | 3/3 | $0.050569 | $0.014521–$0.020260 | 17.49 | 0 |
| single_sol_xhigh | 3/3 | $0.043962 | $0.012331–$0.019018 | 17.13 | 0 |

Jev child routes: gpt-6-luna/low × 3.

Optional policy vs single Sol xhigh gate: FAIL; quality=PASS over 3 successful control blocks, cost=FAIL or unknown.

Jev child vs fixed Sol high child gate: PASS; quality=PASS over 3 successful control blocks, cost=PASS.

Cheaper profile for an already justified child on this fixture task: YES.

## source_lookup

Complete blocks: 3

| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 3/3 | $0.124171 | $0.039281–$0.044906 | 36.06 | 0 |
| jev_routed_child | 3/3 | $0.073477 | $0.023906–$0.025219 | 26.81 | 0 |
| optional_delegation | 3/3 | $0.057677 | $0.014317–$0.024212 | 17.54 | 0 |
| single_sol_xhigh | 3/3 | $0.061886 | $0.011747–$0.034796 | 19.49 | 0 |

Jev child routes: gpt-6-luna/low × 3.

Optional policy vs single Sol xhigh gate: FAIL; quality=PASS over 3 successful control blocks, cost=FAIL or unknown.

Jev child vs fixed Sol high child gate: PASS; quality=PASS over 3 successful control blocks, cost=PASS.

Cheaper profile for an already justified child on this fixture task: YES.

## source_research

Complete blocks: 3

| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed_sol_high_child | 3/3 | $0.162270 | $0.035645–$0.065588 | 35.94 | 0 |
| jev_routed_child | 3/3 | $0.125772 | $0.039739–$0.045029 | 38.74 | 0 |
| optional_delegation | 3/3 | $0.055962 | $0.017969–$0.019997 | 26.11 | 0 |
| single_sol_xhigh | 3/3 | $0.050236 | $0.014864–$0.019213 | 19.90 | 0 |

Jev child routes: gpt-6-sol/high × 3.

Optional policy vs single Sol xhigh gate: FAIL; quality=PASS over 3 successful control blocks, cost=FAIL or unknown.

Jev child vs fixed Sol high child gate: NO ROUTE CHANGE; quality=PASS over 3 successful control blocks, cost=PASS.

Cheaper profile for an already justified child on this fixture task: NO; Jev selected the fixed Sol high profile, so numeric price differences are same-model variation.

This small synthetic corpus measures one task per type. If optional delegation spawns no child, its cost difference from the same-model single control can be run-to-run variation rather than a causal routing saving. Passing gates do not establish general savings or quality equivalence.

