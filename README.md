# Codex Jev Router benchmarks

[Русская инструкция](README.ru.md) · [Full benchmark report](BENCHMARK.md) · [Router project](https://github.com/suenot/codex-jev-router)

This repository holds the benchmark runner, grading code, task inputs, traces, patches, and measurements for Codex subagent model routing. The router's installation and runtime code live in [suenot/codex-jev-router](https://github.com/suenot/codex-jev-router). The benchmark materials were moved from that repository after version 0.7.0; the report and raw artifacts are preserved here.

## Estimated API cost savings

In the selected real-task sample, the estimated API cost **fell 71.0%**, from **$0.214806 to $0.062317**, across nine paired Django source-task runs (9/9 correct in each arm). For three paired runs of one bounded Django fix, it **fell 98.3%**, from **$0.555916 to $0.009668** (3/3 official tests passed in each arm). Routed totals include the separately priced Jev decisions. Estimates apply published Standard, short-context API rates to measured input, cached input, and output tokens.

These are **API price estimates, not measured Codex subscription charges or a general saving**. Same-model controls show run-to-run variation, and the historical synthetic run lacks a clean baseline. See the [cost calculation and limits](BENCHMARK.md#estimated-api-cost-savings).

## Contents

- [BENCHMARK.md](BENCHMARK.md): results, price assumptions, limitations, and links to each case.
- [benchmarks/](benchmarks/): recorded public task inputs, responses, event traces, patches, grades, and selection audits.
- [scripts/benchmark.mjs](scripts/benchmark.mjs): synthetic inline-evidence runner. It does **not** reproduce the Django and pytest editing experiments automatically.
- [benchmarks/django-source-tasks-2026-09-24/grade.py](benchmarks/django-source-tasks-2026-09-24/grade.py): checks the recorded 18 source-task answers; pass `--source` to verify facts against the pinned Django checkout too.

## Setup and checks

Clone both repositories as siblings, and install the router's pinned dependency:

```sh
gh repo clone suenot/codex-jev-router
gh repo clone suenot/codex-jev-router-benchmarks
cd codex-jev-router
npm ci
cd ../codex-jev-router-benchmarks
npm run check
```

For another directory layout, set `CODEX_ROUTER_REPO=/absolute/path/to/codex-jev-router`. The benchmark runner imports that checkout's `src/router.mjs` and `src/decider.mjs`; it does not bundle a second router implementation.

To run the **synthetic** benchmark again, use a working Codex CLI login and a configured decision backend in the environment inherited by the command:

```sh
npm run benchmark -- --repetitions 3 --output /tmp/codex-router-benchmark.json
```

The runner creates a temporary Codex home containing only a link to the active authentication file. It removes that home and its fixture directory afterward. Read [BENCHMARK.md](BENCHMARK.md) before comparing token counts or illustrative API prices: the historical synthetic run predates the isolation fix, and real-repository results cover a small selected sample.
