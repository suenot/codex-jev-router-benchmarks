"""Verify the saved directly routed root runs and compare them with the pinned baseline."""

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


def close(actual, expected):
    return math.isclose(actual, expected, rel_tol=0, abs_tol=1e-10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    args = parser.parse_args()
    data = json.loads(args.results.read_text())
    baseline = json.loads((SUITE / data["baseline_source"]).read_text())
    digest = hashlib.sha256((SUITE / "manifest.json").read_bytes()).hexdigest()
    if data["manifest_sha256"] != digest or baseline["manifest_sha256"] != digest:
        raise ValueError("Results and baseline must use the same pinned manifest")
    if data["base_commit"] != baseline["base_commit"]:
        raise ValueError("Django source commit differs between arms")

    expected = {(task["id"], repetition) for task in data["tasks"]
                for repetition in range(1, data["repetitions"] + 1)}
    observed = [(run["task"], run["repetition"]) for run in data["runs"]]
    if len(observed) != len(expected) or set(observed) != expected:
        raise ValueError("Missing or duplicated directly routed task runs")
    baseline_runs = {(run["task"], run["repetition"], run["arm"]): run
                     for run in baseline["runs"]}
    rates = data["pricing"]["rates"]
    for run in data["runs"]:
        key = (run["task"], run["repetition"])
        if run["arm"] != "direct_routed_root" or not run["protocol_ok"] or run["exit_code"] != 0:
            raise ValueError(f"Invalid run protocol: {key}")
        if run["timed_out"] or not run["root_usage_matches_rollout"] or len(run["sessions"]) != 1:
            raise ValueError(f"Incomplete or delegated root run: {key}")
        route = run["route"]
        old_route = baseline_runs[(*key, "routed_parent")]["route"]
        if (route["model"], route["reasoning_effort"]) != (
            old_route["model"], old_route["reasoning_effort"]
        ):
            raise ValueError(f"Model route differs from the saved comparison: {key}")
        session = run["sessions"][0]
        if session["parent_id"] is not None or session["id"] != run["root_thread_id"]:
            raise ValueError(f"Observed root is a child or has the wrong ID: {key}")
        if (session["model"], session["reasoning_effort"]) != (
            route["model"], route["reasoning_effort"]
        ):
            raise ValueError(f"Observed model differs from Jev's choice: {key}")
        usage = session["usage"]
        if any(usage[name] != run["root_usage"][name]
               for name in ("input_tokens", "cached_input_tokens", "output_tokens")):
            raise ValueError(f"Event and session usage differ: {key}")
        inp, cached, output = (usage[name] for name in
                               ("input_tokens", "cached_input_tokens", "output_tokens"))
        write = usage.get("cache_write_input_tokens", 0)
        if any(type(value) is not int or value < 0 for value in (inp, cached, output, write)) or cached > inp:
            raise ValueError(f"Invalid token counts: {key}")
        model_rate = rates[session["model"]]
        codex_cost = ((inp - cached) * model_rate["input"] + cached * model_rate["cached"] +
                      write * model_rate["cache_write"] + output * model_rate["output"]) / 1_000_000
        jev_cost = route["usage"]["input_tokens"] * 0.042 / 1_000_000
        if not close(codex_cost, run["estimated_codex_api_usd"]) or not close(jev_cost, run["estimated_jev_api_usd"]):
            raise ValueError(f"Price components differ from measured usage: {key}")
        if not close(codex_cost + jev_cost, run["estimated_total_api_usd"]):
            raise ValueError(f"Saved total price is wrong: {key}")
        if run["codex_tokens"] != inp + output or run["end_to_end_ms"] != run["wall_ms"] + route["wall_ms"]:
            raise ValueError(f"Saved token or duration total is wrong: {key}")
        correct, _ = grade(run["task"], run["answer"])
        if correct != run["grade"]["correct"]:
            raise ValueError(f"Grade differs from saved answer: {key}")
        trace = args.results.parent / run["trace"]
        events = [json.loads(line) for line in trace.read_text().splitlines() if line]
        if not any(event.get("type") == "thread.started" and
                   event.get("thread_id") == session["id"] for event in events):
            raise ValueError(f"Missing root thread in trace: {key}")

    direct = [baseline_runs[(*key, "single_sol_high")] for key in expected]
    direct_cost = sum(run["estimated_total_api_usd"] for run in direct)
    routed_cost = sum(run["estimated_total_api_usd"] for run in data["runs"])
    print(f"Audited {len(data['runs'])} direct-root runs; model/effort, grade, usage, prices, and traces verified")
    print(f"Historical direct Sol high: {sum(run['grade']['correct'] for run in direct)}/{len(direct)} strict, ${direct_cost:.6f}")
    print(f"Direct Jev route: {sum(run['grade']['correct'] for run in data['runs'])}/{len(data['runs'])} strict, ${routed_cost:.6f}")
    print(f"Calculated API-price difference: {(1 - routed_cost / direct_cost) * 100:.2f}% lower")
    print("Routes by profile:", dict(sorted(Counter((run["route"]["model"], run["route"]["reasoning_effort"])
                                             for run in data["runs"]).items())))


if __name__ == "__main__":
    main()
