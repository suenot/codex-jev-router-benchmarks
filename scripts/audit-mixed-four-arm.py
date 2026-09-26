"""Audit four-arm mixed benchmark usage, prices, traces, and release gates."""

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import statistics
import subprocess
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "benchmarks" / "mixed-2026-09-26"
ARMS = {"single_sol_xhigh", "fixed_sol_high_child", "jev_routed_child", "optional_delegation"}
GRADER_SPEC = importlib.util.spec_from_file_location("mixed_grade", SUITE / "grade.py")
GRADER = importlib.util.module_from_spec(GRADER_SPEC)
GRADER_SPEC.loader.exec_module(GRADER)


def arm_order(task_id, repetition, seed):
    value = (seed ^ repetition) & 0xFFFFFFFF
    for char in task_id:
        value = (value * 33 + ord(char)) & 0xFFFFFFFF
    arms = ["single_sol_xhigh", "fixed_sol_high_child", "jev_routed_child", "optional_delegation"]
    for index in range(len(arms) - 1, 0, -1):
        value ^= (value << 13) & 0xFFFFFFFF
        value ^= value >> 17
        value ^= (value << 5) & 0xFFFFFFFF
        value &= 0xFFFFFFFF
        other = value % (index + 1)
        arms[index], arms[other] = arms[other], arms[index]
    return arms


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture_digest():
    content = hashlib.sha256()
    fixture = SUITE / "fixture"
    for path in sorted(fixture.rglob("*")):
        if path.is_file():
            content.update(path.relative_to(fixture).as_posix().encode())
            content.update(b"\0")
            content.update(path.read_bytes())
            content.update(b"\0")
    return content.hexdigest()


def cost(model, usage, rates):
    rate = rates[model]
    tokens = usage["input_tokens"]
    cached = usage["cached_input_tokens"]
    output = usage["output_tokens"]
    written = usage.get("cache_write_input_tokens", 0)
    if min(tokens, cached, output, written) < 0 or cached > tokens:
        raise ValueError("Invalid token counters")
    return ((tokens - cached) * rate["input"] + cached * rate["cached"] +
            written * rate["cache_write"] + output * rate["output"]) / 1_000_000


def near(actual, expected):
    return actual is not None and abs(actual - expected) < 1e-10


def replay_edit(attempt, result_path):
    artifact = attempt.get("patch")
    if not artifact:
        raise ValueError("Code-edit attempt is missing a saved patch")
    patch_path = result_path.parent / artifact["path"]
    content = patch_path.read_bytes()
    if len(content) != artifact["bytes"] or hashlib.sha256(content).hexdigest() != artifact["sha256"]:
        raise ValueError(f"Patch hash or size mismatch: {patch_path}")
    if content and not content.startswith(b"--- a/src/receipts.mjs\n+++ b/src/receipts.mjs\n"):
        raise ValueError(f"Unexpected patch target: {patch_path}")
    with tempfile.TemporaryDirectory(prefix="audit-mixed-edit-") as temp:
        fixture = Path(temp) / "fixture"
        shutil.copytree(SUITE / "fixture", fixture)
        if content:
            applied = subprocess.run(["patch", "-p1"], cwd=fixture, input=content, capture_output=True)
            if applied.returncode:
                raise ValueError(f"Patch does not apply to pinned fixture: {patch_path}")
        behavior = subprocess.run(["node", str(SUITE / "check-receipt.mjs"), str(fixture)], capture_output=True)
        changed = ["src/receipts.mjs"] if content else []
        if changed != attempt["changed_paths"]:
            raise ValueError(f"Changed-path record differs from patch: {patch_path}")
        try:
            completion = json.loads(attempt["answer"].strip()) == {"done": True}
        except (TypeError, ValueError):
            completion = False
        expected_pass = bool(completion and changed == ["src/receipts.mjs"] and behavior.returncode == 0)
        if attempt["grade"]["correct"] != expected_pass:
            raise ValueError(f"Edit grade does not replay: {patch_path}")


def audit(data, result_path, policy_file):
    ident = data["identity"]
    if ident["manifest_sha256"] != digest(SUITE / "manifest.json"):
        raise ValueError("Manifest changed since run")
    if ident["fixture_sha256"] != fixture_digest():
        raise ValueError("Fixture changed since run")
    grader_hash = digest(SUITE / "grade.py") + ":" + digest(SUITE / "check-receipt.mjs")
    if ident["grader_sha256"] != grader_hash:
        raise ValueError("Grader changed since run")
    if ident["runner_sha256"] != digest(ROOT / "scripts" / "mixed-four-arm.mjs"):
        raise ValueError("Runner changed since run")
    router_root = Path(os.environ.get("CODEX_ROUTER_REPO", ROOT.parent / "codex-jev-router"))
    if ident["router_sha256"] != digest(router_root / "src" / "router.mjs") or \
       ident["decider_sha256"] != digest(router_root / "src" / "decider.mjs"):
        raise ValueError("Router or decider changed since run")
    if ident["policy_sha256"] != digest(policy_file):
        raise ValueError("Optional-policy snapshot changed since run")
    manifest = json.loads((SUITE / "manifest.json").read_text())
    tasks_by_id = {task["id"]: task for task in manifest["tasks"]}
    expected_schedule = [{"task": task, "repetition": repetition,
                          "order": arm_order(task, repetition, ident["seed"])}
                         for repetition in range(1, ident["repetitions"] + 1)
                         for task in ident["selected_tasks"]]
    if data["schedule"] != expected_schedule or ident["seed"] != manifest["seed"]:
        raise ValueError("Randomized schedule differs from the preregistered seed")
    scheduled_keys = [(block["task"], block["repetition"], arm)
                      for block in expected_schedule for arm in block["order"]]
    actual_keys = [(run["task"], run["repetition"], run["arm"]) for run in data["runs"]]
    if actual_keys != scheduled_keys[:len(actual_keys)]:
        raise ValueError("Runs do not follow the randomized schedule")
    expected = {(task, repetition, arm) for task in ident["selected_tasks"]
                for repetition in range(1, ident["repetitions"] + 1) for arm in ARMS}
    seen = set()
    by_block = defaultdict(dict)
    for run in data["runs"]:
        key = (run["task"], run["repetition"], run["arm"])
        if key not in expected or key in seen:
            raise ValueError(f"Unexpected or duplicate run: {key}")
        seen.add(key)
        by_block[key[:2]][key[2]] = run
        if len(run["attempts"]) > ident["max_attempts"] or not run["attempts"]:
            raise ValueError(f"Invalid attempt count: {key}")
        attempts_total = 0.0
        priced = True
        for attempt in run["attempts"]:
            if run["type"] == "code_edit":
                replay_edit(attempt, result_path)
            else:
                answer_ok, _ = GRADER.grade_read(tasks_by_id[run["task"]], attempt["answer"])
                if attempt["grade"]["correct"] != bool(answer_ok and not attempt["changed_paths"]):
                    raise ValueError(f"Read answer grade does not replay: {key}")
            trace = result_path.parent / attempt["trace"]
            if not trace.is_file():
                raise ValueError(f"Missing trace: {trace}")
            events = [json.loads(line) for line in trace.read_text().splitlines() if line]
            if not any(event["type"] == "turn.completed" for event in events):
                raise ValueError(f"Missing completion event: {trace}")
            sessions = attempt["sessions"]
            if not sessions:
                raise ValueError(f"No sessions: {key}")
            root = [session for session in sessions if session["model"] == "gpt-6-sol" and
                    session["reasoning_effort"] == "xhigh" and session["id"] == attempt["root_thread_id"] and
                    session["usage"]["input_tokens"] == attempt["root_usage"]["input_tokens"] and
                    session["usage"]["output_tokens"] == attempt["root_usage"]["output_tokens"]]
            if len(root) != 1:
                raise ValueError(f"Root session mismatch: {key}")
            children = [session for session in sessions if session is not root[0]]
            if run["arm"] == "single_sol_xhigh" and children:
                raise ValueError(f"Unexpected child: {key}")
            if run["arm"] in {"fixed_sol_high_child", "jev_routed_child"} and len(children) != 1:
                raise ValueError(f"Missing or extra child: {key}")
            if run["arm"] == "optional_delegation" and len(children) != len(attempt["decisions"]):
                raise ValueError(f"Optional delegation/decision mismatch: {key}")
            expected_route = ({"model": "gpt-6-sol", "reasoning_effort": "high"}
                              if run["arm"] == "fixed_sol_high_child" else
                              attempt["decisions"][0]["route"] if attempt["decisions"] else None)
            if any(child["model"] != expected_route["model"] or
                   child["reasoning_effort"] != expected_route["reasoning_effort"]
                   for child in children):
                raise ValueError(f"Child route mismatch: {key}")
            if any(session["model"] not in data["pricing"]["codex"] or
                   (session["model"] == "gpt-6-sol" and session["reasoning_effort"] == "low")
                   for session in sessions):
                raise ValueError(f"Forbidden or unpriced model route: {key}")
            codex = sum(cost(session["model"], session["usage"], data["pricing"]["codex"])
                        for session in sessions)
            if not near(attempt["estimated_codex_api_usd"], codex):
                raise ValueError(f"Codex price mismatch: {key}")
            decisions = attempt["decisions"]
            if run["arm"] == "jev_routed_child" and len(decisions) != 1:
                raise ValueError(f"Missing Jev decision: {key}")
            jev_inputs = [decision.get("usage", {}).get("input_tokens") for decision in decisions]
            if any(value is None for value in jev_inputs):
                priced = False
                if attempt["estimated_total_api_usd"] is not None:
                    raise ValueError(f"Unknown Jev cost marked complete: {key}")
            else:
                jev = sum(jev_inputs) * data["pricing"]["jev_input"] / 1_000_000
                if not near(attempt["estimated_jev_api_usd"], jev) or not near(
                        attempt["estimated_total_api_usd"], codex + jev):
                    raise ValueError(f"Jev/total price mismatch: {key}")
                attempts_total += codex + jev
        if priced and not near(run["estimated_total_api_usd"], attempts_total):
            raise ValueError(f"Retry-inclusive run price mismatch: {key}")
        if not priced and run["estimated_total_api_usd"] is not None:
            raise ValueError(f"Unpriced attempt omitted from run total: {key}")
        if run["passed"] != bool(run["grade"]["correct"] and run["protocol_ok"] and
                                   run["attempts"][-1]["exit_code"] == 0):
            raise ValueError(f"Pass flag mismatch: {key}")
        if run["end_to_end_ms"] != sum(attempt["end_to_end_ms"] for attempt in run["attempts"]):
            raise ValueError(f"Retry-inclusive elapsed time mismatch: {key}")
    complete = seen == expected
    if not complete:
        print(f"INCOMPLETE: {len(seen)}/{len(expected)} scheduled runs; no release gate evaluated")
    lines = ["# Mixed four-arm benchmark audit", "",
             f"Runs: {len(seen)}/{len(expected)}; three repeats and all four arms are required for release decisions.", "",
             "Costs include every recorded attempt, parent and child Codex sessions, cached and uncached input, output, cache writes, and Jev decisions where made. [OpenAI Standard short-context rates](https://developers.openai.com/api/docs/pricing) and [TypeSafe's published $0.042/M Jev input rate](https://typesafe.ai/blog/introducing-system-one-models-and-jev) are assumptions; TypeSafe lists Jev output free. Possible tool fees, other charges, and subscription billing are not measured.", "",
             "This public synthetic fixture contains offline source research. It does not measure live web research, continuing terminal threads or their context cache, production billing, or a broad production task distribution.", ""]
    by_type = defaultdict(list)
    task_type = {task["id"]: task["type"] for task in manifest["tasks"]}
    for key, arms in by_block.items():
        if len(arms) == 4:
            by_type[task_type[key[0]]].append(arms)
    complete_blocks = [arms for arms in by_block.values() if len(arms) == 4]
    if complete_blocks:
        baseline_costs = [block["single_sol_xhigh"]["estimated_total_api_usd"] for block in complete_blocks]
        baseline_total = sum(baseline_costs) if all(value is not None for value in baseline_costs) else None
        lines.extend(["## All complete blocks", "", "| Arm | Strict passes | Total USD | Change vs single | Median seconds | Retries | Child sessions | Jev decisions |",
                      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"])
        for arm in sorted(ARMS):
            runs = [block[arm] for block in complete_blocks]
            costs = [run["estimated_total_api_usd"] for run in runs]
            price = f"${sum(costs):.6f}" if all(value is not None for value in costs) else "unknown"
            change = f"{(sum(costs) / baseline_total - 1) * 100:+.1f}%" if baseline_total and all(value is not None for value in costs) else "unknown"
            children = sum(len(attempt["sessions"]) - 1 for run in runs for attempt in run["attempts"])
            decisions = sum(len(attempt["decisions"]) for run in runs for attempt in run["attempts"])
            retries = sum(len(run["attempts"]) - 1 for run in runs)
            median = statistics.median(run["end_to_end_ms"] / 1000 for run in runs)
            lines.append(f"| {arm} | {sum(run['passed'] for run in runs)}/{len(runs)} | {price} | {change} | {median:.2f} | {retries} | {children} | {decisions} |")
        lines.append("")
    for type_name, blocks in sorted(by_type.items()):
        lines.extend([f"## {type_name}", "", f"Complete blocks: {len(blocks)}", "",
                      "| Arm | Strict passes | Total USD | Per-run USD range | Median seconds | Retries |",
                      "| --- | ---: | ---: | ---: | ---: | ---: |"])
        for arm in sorted(ARMS):
            runs = [block[arm] for block in blocks]
            costs = [run["estimated_total_api_usd"] for run in runs]
            price = f"${sum(costs):.6f}" if all(value is not None for value in costs) else "unknown"
            spread = f"${min(costs):.6f}–${max(costs):.6f}" if all(value is not None for value in costs) else "unknown"
            seconds = statistics.median(run["end_to_end_ms"] / 1000 for run in runs)
            retries = sum(len(run["attempts"]) - 1 for run in runs)
            lines.append(f"| {arm} | {sum(run['passed'] for run in runs)}/{len(runs)} | {price} | {spread} | {seconds:.2f} | {retries} |")
        lines.append("")
        if len(blocks) != 3 * sum(task_type[task] == type_name for task in ident["selected_tasks"]):
            lines.append("Release gate: pending incomplete blocks.\n")
            continue
        costs = {arm: [block[arm]["estimated_total_api_usd"] for block in blocks] for arm in ARMS}
        priced = all(all(value is not None for value in values) for values in costs.values())
        routed_profiles = Counter((decision["route"]["model"], decision["route"]["reasoning_effort"])
                                  for block in blocks for attempt in block["jev_routed_child"]["attempts"]
                                  for decision in attempt["decisions"])
        cheaper_route = bool(routed_profiles) and all(model == "gpt-6-luna" for model, _ in routed_profiles)
        lines.append("Jev child routes: " + ", ".join(f"{model}/{effort} × {count}"
                                                   for (model, effort), count in sorted(routed_profiles.items())) + ".\n")
        jev_numeric_pass = False
        for candidate, control, title in [
            ("optional_delegation", "single_sol_xhigh", "Optional policy vs single Sol xhigh"),
            ("jev_routed_child", "fixed_sol_high_child", "Jev child vs fixed Sol high child"),
        ]:
            comparable = [block for block in blocks if block[control]["passed"]]
            quality_ok = bool(comparable) and all(block[candidate]["passed"] for block in comparable)
            cost_ok = priced and sum(costs[candidate]) <= 0.9 * sum(costs[control])
            if candidate == "jev_routed_child":
                jev_numeric_pass = quality_ok and cost_ok
            verdict = "NO ROUTE CHANGE" if candidate == "jev_routed_child" and not cheaper_route else \
                "PASS" if quality_ok and cost_ok else "FAIL"
            lines.append(f"{title} gate: {verdict}; quality={'PASS' if quality_ok else 'FAIL'} over {len(comparable)} successful control blocks, cost={'PASS' if cost_ok else 'FAIL or unknown'}.\n")
        lines.append(f"Cheaper profile for an already justified child on this fixture task: {'YES' if jev_numeric_pass and cheaper_route else 'NO'}"
                     + ("." if cheaper_route else "; Jev selected the fixed Sol high profile, so numeric price differences are same-model variation.") + "\n")
    if complete:
        lines.append("This small synthetic corpus measures one task per type. If optional delegation spawns no child, its cost difference from the same-model single control can be run-to-run variation rather than a causal routing saving. Passing gates do not establish general savings or quality equivalence.\n")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--policy-file", type=Path, default=SUITE / "optional-policy.md")
    args = parser.parse_args()
    report = audit(json.loads(args.results.read_text()), args.results, args.policy_file)
    if args.report:
        args.report.write_text(report)
    print(report)


if __name__ == "__main__":
    main()
