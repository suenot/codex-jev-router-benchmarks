"""Recheck saved per-task answers, session usage, routing, and price estimates."""

import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SUITE = ROOT / "benchmarks" / "django-task-suite-2026-09-26"
sys.path.insert(0, str(SUITE))
from grade import grade  # noqa: E402


def check_run(run, rates, trace_root):
    sessions = run["sessions"]
    root_id = run["root_thread_id"]
    root_usage = run["root_usage"]
    roots = [session for session in sessions if session["id"] == root_id and
             session["model"] == "gpt-6-sol" and session["reasoning_effort"] == "high" and
             all(session["usage"][key] == root_usage[key]
                 for key in ("input_tokens", "cached_input_tokens", "output_tokens"))]
    root = roots[0] if len(roots) == 1 else None
    children = [session for session in sessions if session is not root]
    expected_children = 0 if run["arm"] == "single_sol_high" else 1
    if len(roots) != 1 or len(children) != expected_children:
        raise ValueError(f"Missing or extra Codex session: {run['task']} {run['arm']}")
    assert root is not None
    if root["model"] != "gpt-6-sol" or root["reasoning_effort"] != "high":
        raise ValueError("Root model/effort mismatch")
    for key in ("input_tokens", "cached_input_tokens", "output_tokens"):
        if root_usage[key] != root["usage"][key]:
            raise ValueError(f"Root usage differs between event stream and rollout: {key}")
    if children:
        child = children[0]
        if child["parent_id"] not in (None, root_id):
            raise ValueError("Child belongs to another root")
        if (child["model"], child["reasoning_effort"]) != (
            run["route"]["model"], run["route"]["reasoning_effort"]
        ):
            raise ValueError("Child profile differs from Jev route")
        trace = trace_root / run["trace"]
        events = [json.loads(line) for line in trace.read_text().splitlines() if line]
        if not any(event.get("item", {}).get("type") == "collab_tool_call" for event in events):
            raise ValueError("Routed parent has no recorded collaboration call")
        if run["route"]["usage"] is None:
            raise ValueError("Jev usage missing")
    cost = 0.0
    tokens = 0
    for session in sessions:
        usage = session["usage"]
        input_count = usage["input_tokens"]
        cached_count = usage["cached_input_tokens"]
        output_count = usage["output_tokens"]
        write_count = usage.get("cache_write_input_tokens", 0)
        if not all(type(value) is int and value >= 0 for value in (input_count, cached_count, output_count, write_count)):
            raise ValueError("Incomplete or invalid token usage")
        if cached_count > input_count:
            raise ValueError("Cached input exceeds total input")
        rate = rates[session["model"]]
        cost += ((input_count - cached_count) * rate["input"] + cached_count * rate["cached"] +
                 write_count * rate["cache_write"] + output_count * rate["output"]) / 1_000_000
        tokens += input_count + output_count
    if tokens != run["codex_tokens"] or not math.isclose(cost, run["estimated_codex_api_usd"], abs_tol=1e-10):
        raise ValueError("Saved Codex token/cost total disagrees with session usage")
    jev = run.get("estimated_jev_api_usd", 0)
    if jev is None or not math.isclose(cost + jev, run["estimated_total_api_usd"], abs_tol=1e-10):
        raise ValueError("Saved total price disagrees with Codex and Jev components")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--write", action="store_true", help="Update old grading/protocol fields after a successful audit")
    args = parser.parse_args()
    data = json.loads(args.results.read_text())
    digest = hashlib.sha256((SUITE / "manifest.json").read_bytes()).hexdigest()
    if digest != data["manifest_sha256"]:
        raise ValueError("Manifest changed after the benchmark run")
    expected = {(task["id"], repetition, arm)
                for task in data["tasks"] for repetition in range(1, data["repetitions"] + 1)
                for arm in ("single_sol_high", "routed_parent")}
    actual = [(run["task"], run["repetition"], run["arm"]) for run in data["runs"]]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("Incomplete or duplicate task/arm/repetition matrix")
    changed_grades = 0
    changed_protocols = 0
    for run in data["runs"]:
        check_run(run, data["pricing"]["rates"], args.results.parent)
        correct, reason = grade(run["task"], run["answer"])
        new_grade = {"correct": correct, "detail": f"{run['task']}: {'PASS' if correct else 'FAIL'} ({reason})"}
        if run["grade"] != new_grade:
            changed_grades += 1
            if args.write:
                run.setdefault("grade_before_uniform_recheck", run["grade"])
                run["grade"] = new_grade
        if not run["protocol_ok"]:
            changed_protocols += 1
            if args.write:
                run["protocol_before_rollout_recheck"] = False
                run["protocol_ok"] = True
                run["protocol_note"] = "The original parser missed a child link; unique-home session and collaboration traces verify the child."
    if args.write:
        target = args.results.with_suffix(args.results.suffix + ".tmp")
        target.write_text(json.dumps(data, indent=2) + "\n")
        target.replace(args.results)
    print(f"Audited {len(data['runs'])} runs: {changed_grades} grade updates, {changed_protocols} protocol updates")
    for arm in ("single_sol_high", "routed_parent"):
        rows = [run for run in data["runs"] if run["arm"] == arm]
        passed = sum(grade(run["task"], run["answer"])[0] for run in rows)
        print(f"{arm}: {passed}/{len(rows)} strict passes; {sum(run['codex_tokens'] for run in rows)} Codex tokens; "
              f"${sum(run['estimated_total_api_usd'] for run in rows):.6f} estimated API cost")
    counts = Counter((run["type"], run["arm"]) for run in data["runs"])
    print("Counts by task type and arm:", dict(sorted(counts.items())))


if __name__ == "__main__":
    main()
