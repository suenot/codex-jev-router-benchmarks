"""Recheck saved four-task Codex batch answers, session usage, and prices."""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SUITE = ROOT / "benchmarks" / "django-task-suite-2026-09-26"
sys.path.insert(0, str(SUITE))
from grade import grade  # noqa: E402


def price(sessions, rates):
    total = 0.0
    tokens = 0
    for session in sessions:
        usage = session["usage"]
        values = [usage.get(key) for key in ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")]
        if not all(type(value) is int and value >= 0 for value in values) or values[1] > values[0]:
            raise ValueError("Invalid session token counters")
        rate = rates[session["model"]]
        total += ((values[0] - values[1]) * rate["input"] + values[1] * rate["cached"] +
                  values[2] * rate["cache_write"] + values[3] * rate["output"]) / 1_000_000
        tokens += values[0] + values[3]
    return total, tokens


def audit_run(run, data, suite_dir):
    sessions = run["sessions"]
    root_usage = run["root_usage"]
    root_candidates = [session for session in sessions if session["id"] == run["root_thread_id"] and
                       session["model"] == "gpt-6-sol" and session["reasoning_effort"] == "high" and
                       all(session["usage"][key] == root_usage[key]
                           for key in ("input_tokens", "cached_input_tokens", "output_tokens"))]
    if len(root_candidates) != 1:
        raise ValueError(f"Cannot identify unique root rollout: {run['group']} {run['arm']}")
    root = root_candidates[0]
    children = [session for session in sessions if session is not root]
    required_children = 0 if run["arm"] == "single_sol_high" else 4
    if len(children) != required_children:
        raise ValueError("Unexpected child count")
    if children:
        observed = sorted((child["model"], child["reasoning_effort"]) for child in children)
        routed = sorted((route["model"], route["reasoning_effort"]) for route in run["routes"])
        if observed != routed:
            raise ValueError("Child models/efforts differ from recorded routes")
        if not all(child["parent_id"] in (None, root["id"]) for child in children):
            raise ValueError("Child linked to another root")
        if not all(route["usage"] and type(route["usage"].get("input_tokens")) is int for route in run["routes"]):
            raise ValueError("Jev token usage missing")
    for session in sessions:
        if not (suite_dir / data["trace_directory"] / session["trace"]).is_file():
            raise ValueError("Missing rollout trace")
    if not (suite_dir / data["trace_directory"] / run["traces"]["events"]).is_file():
        raise ValueError("Missing root event trace")
    codex_cost, tokens = price(sessions, data["pricing"]["rates"])
    if not math.isclose(codex_cost, run["estimated_codex_api_usd"], abs_tol=1e-10) or tokens != run["codex_tokens"]:
        raise ValueError("Saved Codex price/tokens differ from session records")
    jev_cost = run.get("estimated_jev_api_usd", 0)
    if jev_cost is None or not math.isclose(codex_cost + jev_cost, run["estimated_total_api_usd"], abs_tol=1e-10):
        raise ValueError("Saved total price differs from components")
    try:
        answers = json.loads(run["answer"])["answers"]
    except (ValueError, KeyError, TypeError):
        answers = {}
    grades = []
    for task_id in run["task_ids"]:
        raw = json.dumps(answers[task_id], ensure_ascii=False) if task_id in answers else ""
        correct, reason = grade(task_id, raw)
        grades.append({"task": task_id, "correct": correct,
                       "detail": f"{task_id}: {'PASS' if correct else 'FAIL'} ({reason})"})
    return grades


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    data = json.loads(args.results.read_text())
    if hashlib.sha256((SUITE / "manifest.json").read_bytes()).hexdigest() != data["manifest_sha256"]:
        raise ValueError("Manifest changed after benchmark run")
    expected = {(group["id"], repetition, arm)
                for group in data["groups"] for repetition in range(1, data["repetitions"] + 1)
                for arm in ("single_sol_high", "routed_parent")}
    actual = [(run["group"], run["repetition"], run["arm"]) for run in data["runs"]]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("Incomplete or duplicate group/arm/repetition matrix")
    changed = 0
    for run in data["runs"]:
        grades = audit_run(run, data, args.results.parent)
        if grades != run["grades"]:
            changed += 1
            if args.write:
                run.setdefault("grades_before_uniform_recheck", run["grades"])
                run["grades"] = grades
                run["correct_count"] = sum(item["correct"] for item in grades)
                run["all_correct"] = run["correct_count"] == 4 and not run["extra_answer_ids"]
    if args.write:
        target = args.results.with_suffix(args.results.suffix + ".tmp")
        target.write_text(json.dumps(data, indent=2) + "\n")
        target.replace(args.results)
    print(f"Audited {len(data['runs'])} batch runs; {changed} grade updates")
    for arm in ("single_sol_high", "routed_parent"):
        rows = [run for run in data["runs"] if run["arm"] == arm]
        passed = sum(sum(item["correct"] for item in audit_run(run, data, args.results.parent)) for run in rows)
        print(f"{arm}: {passed}/{4 * len(rows)} strict answers; {sum(run['codex_tokens'] for run in rows)} Codex tokens; "
              f"${sum(run['estimated_total_api_usd'] for run in rows):.6f} estimated API cost")


if __name__ == "__main__":
    main()
