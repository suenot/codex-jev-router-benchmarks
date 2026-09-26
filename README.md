# Codex Jev Router benchmarks

[Русская инструкция](README.ru.md) · [Full benchmark report](BENCHMARK.md) · [Router project](https://github.com/suenot/codex-jev-router)

This repository holds the benchmark runner, grading code, task inputs, traces, patches, and measurements for Codex subagent model routing. The router's installation and runtime code live in [suenot/codex-jev-router](https://github.com/suenot/codex-jev-router). The benchmark materials were moved from that repository after version 0.7.0; the report and raw artifacts are preserved here.

The [new mixed four-arm run](BENCHMARK.md#audited-72-run-result) completed 72 comparisons on six public synthetic tasks, with three repetitions per arm. All four arms passed 18/18 strict checks. Optional delegation used no children and cost an estimated **2.7% more** than one Sol-xhigh root; Jev-routed children cost **27.2% less** than fixed Sol-high children but **69.7% more** than the single-root workflow. Luna low for exact lookups and Luna medium for bounded extraction passed the child-only comparison on one fixture task each. These results do not show an overall money saving against the single-root workflow.

## Full-workflow cost comparison

Routing **before a root Codex session** gave a different result on the same 12 selected Django source tasks, twice each: Jev-routed single sessions cost an estimated **$0.184377** including Jev versus **$0.452677** for the saved direct Sol-high control, **59.3% less**. Strict checks passed **21/24 versus 22/24**, and elapsed time was **5.4% longer**. This is a historical comparison, not randomized A/B evidence of equal quality. Luna routes produced the aggregate saving; the Sol-low subset was **34.7% more expensive** than its direct Sol-high control. See the [direct-root experiment](BENCHMARK.md#direct-routing-before-the-root-codex-turn).

On 12 preregistered Django source tasks, repeated twice per arm, a single Sol-high Codex session cost an estimated **$0.452677** and passed **22/24** strict checks. A Sol-high parent plus one Jev-routed child per task cost **$0.657100** and passed **21/24**: **45.2% more expensive**, including Jev. In six four-task runs using the same tasks, one continuing Sol-high session cost **$0.193704** (20/24 strict checks); a Sol-high parent with four routed children cost **$0.547248** (22/24), **182.5% more**. The checks include output format and precise source citations. See the [full-workflow method and results](BENCHMARK.md#full-codex-workflow-one-sol-high-agent-or-a-routed-subagent).

One paired Django code fix gave a different outcome: both arms passed the local official test; Sol high alone cost **$0.144088**, while a Sol-high parent with a Jev-selected Luna-medium child cost **$0.056660**, **60.7% less** but **50.5% slower**. This is one trial, not a general saving. [Patches, test logs, method, and limits](BENCHMARK.md#full-codex-workflow-one-real-django-code-fix).

## Earlier selected worker-only savings

In an earlier selected sample that priced **only the chosen worker and Jev decision**, the estimated API cost fell 71.0%, from $0.214806 to $0.062317, across nine paired Django source-task runs (9/9 correct in each arm). For three paired runs of one bounded Django fix, it fell 98.3%, from $0.555916 to $0.009668 (3/3 official tests passed in each arm). **Those comparisons exclude the Sol-high parent's work** and therefore do not establish savings for the complete subagent workflow. Estimates apply published Standard, short-context API rates to measured input, cached input, and output tokens.

These are **API price estimates, not measured Codex subscription charges or a general saving**. Same-model controls show run-to-run variation, and the historical synthetic run lacks a clean baseline. See the [cost calculation and limits](BENCHMARK.md#earlier-selected-worker-only-cost-savings).

## Contents

- [BENCHMARK.md](BENCHMARK.md): results, price assumptions, limitations, and links to each case.
- [benchmarks/](benchmarks/): recorded public task inputs, responses, event traces, patches, grades, and selection audits.
- [scripts/benchmark.mjs](scripts/benchmark.mjs): synthetic inline-evidence runner. It does **not** reproduce the Django and pytest editing experiments automatically.
- [benchmarks/django-source-tasks-2026-09-24/grade.py](benchmarks/django-source-tasks-2026-09-24/grade.py): checks the recorded 18 source-task answers; pass `--source` to verify facts against the pinned Django checkout too.
- [scripts/agent-overhead.mjs](scripts/agent-overhead.mjs): runs the 12-task pinned Django suite with a clean single Sol-high Codex session versus a Sol-high parent and one Jev-routed Codex subagent. It counts the parent and child session usage separately, grades exact answers and citations, and records cost estimates and traces.
- [scripts/batch-agent-overhead.mjs](scripts/batch-agent-overhead.mjs): compares one Sol-high session solving four tasks with one Sol-high parent delegating the same four tasks to separately routed subagents. Three fixed groups cover the 12-task suite.
- [scripts/code-fix-agent-overhead.mjs](scripts/code-fix-agent-overhead.mjs): compares the complete single-agent and parent-plus-child workflows on the Django 16527 code fix and can replay the local official test from saved patches.
- [scripts/direct-routed-root.mjs](scripts/direct-routed-root.mjs): asks the configured decider before starting one Codex root session for each pinned source task; [the auditor](scripts/audit-direct-root.py) verifies saved grades, usage, routes, and price estimates.
- [benchmarks/django-task-suite-2026-09-26/](benchmarks/django-task-suite-2026-09-26/): preregistered prompts, expected source facts, grader, paired run results, and Codex JSON event traces.
- [benchmarks/mixed-2026-09-26/](benchmarks/mixed-2026-09-26/): preregistered public synthetic source, log, policy, and code-edit tasks for the four-arm Sol-xhigh workflow comparison. The existing 12 Django tasks remain a diagnostic corpus.
- [scripts/mixed-four-arm.mjs](scripts/mixed-four-arm.mjs): randomized three-repeat four-arm runner; [audit-mixed-four-arm.py](scripts/audit-mixed-four-arm.py) recomputes prices and checks category release gates. See [the protocol](BENCHMARK.md#mixed-four-arm-release-gate).

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

For the real parent-versus-subagent comparison, check out the pinned Django commit recorded in the [suite manifest](benchmarks/django-task-suite-2026-09-26/manifest.json), then run:

```sh
python3 benchmarks/django-task-suite-2026-09-26/grade.py --source /path/to/pinned/django
npm run benchmark:agents -- --repo /path/to/pinned/django --output /tmp/agent-overhead-results.json --repetitions 2
npm run benchmark:batch -- --repo /path/to/pinned/django --output /tmp/batch-overhead-results.json --repetitions 2
npm run benchmark:direct-root -- --repo /path/to/pinned/django --output /tmp/direct-root-results.json --repetitions 2
```

The 12 prompts are read-only and do not use the internet. Each baseline run disables subagents; routed runs start a Sol-high parent and request one child per task with the profile chosen by the configured decision backend. Each run uses a fresh Codex home and alternates arm order. The per-task runner saves the CLI event trace and per-session usage; the batch runner also saves child rollout traces. The price estimate uses observed model, uncached input, cached input, and output tokens. See the [report](BENCHMARK.md) for selection limits and interpretation.

For the mixed suite, a configured Jev backend and Codex CLI login are required. The runner writes incrementally and resumes an output file only when its manifest, policy, task selection, and repeat count match:

```sh
npm run benchmark:mixed -- --output /tmp/mixed-four-arm.json --repetitions 3
npm run audit:mixed -- /tmp/mixed-four-arm.json --report /tmp/mixed-four-arm-report.md
```

Use `--dry-run` to inspect the deterministic arm schedule without model calls. Each attempt copies the public fixture and uses an isolated Codex home. Read tasks require exact JSON values, citations, and unchanged files; the edit task uses hidden behavior checks and a one-file diff rule. Every edit attempt saves a hashed patch that the auditor applies to the pinned fixture before rerunning the hidden checks. Raw rollout text is not published: traces contain event types, final answers, and usage, while session records retain model, effort, and token counters. The optional arm uses a benchmark route shim to record Jev tokens if it chooses to delegate; the shim invokes the same router and decider as the installed instruction.
