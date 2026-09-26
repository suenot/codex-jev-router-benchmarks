"""Deterministically grade the preregistered Django source tasks."""

import argparse
import ast
import json
import subprocess
from pathlib import Path


HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "manifest.json").read_text())
TASKS = {task["id"]: task for task in MANIFEST["tasks"]}


def verify_source(checkout):
    commit = subprocess.check_output(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != MANIFEST["base_commit"]:
        raise ValueError(f"Django checkout is at {commit}, not the pinned commit")
    for task in TASKS.values():
        for location, expected_line in task["source_evidence"].items():
            path, number = location.rsplit(":", 1)
            lines = (checkout / path).read_text().splitlines()
            actual = lines[int(number) - 1].strip()
            if actual != expected_line:
                raise ValueError(f"{task['id']}: {location}: {actual!r} != {expected_line!r}")


def parse_final(raw):
    raw = raw.strip()
    if raw.startswith("```json") and raw.endswith("```"):
        raw = raw[7:-3].strip()
    return json.loads(raw)


def citation_covers(provided, required):
    """Accept either an exact source line or a cited span containing it."""
    try:
        required_path, required_line = required.rsplit(":", 1)
        provided_path, provided_lines = provided.rsplit(":", 1)
        if provided_path != required_path:
            return False
        first, _, last = provided_lines.replace("–", "-").partition("-")
        first = int(first)
        last = int(last) if last else first
        return first <= int(required_line) <= last and 0 <= last - first <= 10
    except (ValueError, TypeError):
        return False


def grade(task_id, raw_answer):
    """Return (passed, reason) for one final answer string."""
    task = TASKS[task_id]
    try:
        result = parse_final(raw_answer)
    except (ValueError, TypeError) as exc:
        return False, f"invalid JSON: {exc}"
    if not isinstance(result, dict):
        return False, "answer mismatch"
    answer = result.get("answer")
    # The prompt requests two literals in source order but does not require an array.
    if task_id == "forms-normalization" and isinstance(answer, dict):
        literals = answer.get("boolean_false_strings")
        if isinstance(literals, str):
            if len(literals) < 100 and literals.startswith("(") and literals.endswith(")"):
                try:
                    parsed_literals = ast.literal_eval(literals)
                except (SyntaxError, ValueError):
                    parsed_literals = None
                if isinstance(parsed_literals, tuple) and all(isinstance(item, str) for item in parsed_literals):
                    literals = list(parsed_literals)
            if isinstance(literals, str):
                literals = [part.strip() for part in literals.split(",")]
            answer = {**answer, "boolean_false_strings": literals}
    if isinstance(answer, dict):
        answer = dict(answer)
        for key, expected in task["expected_answer"].items():
            if type(expected) is int and isinstance(answer.get(key), str) and answer[key].isdecimal():
                answer[key] = int(answer[key])
    if json.dumps(
        answer, sort_keys=True, ensure_ascii=False
    ) != json.dumps(task["expected_answer"], sort_keys=True, ensure_ascii=False):
        return False, "answer mismatch"
    citations = result.get("citations")
    if not isinstance(citations, dict):
        return False, "citations must be an object"
    for key, required in task["required_citations"].items():
        provided = citations.get(key)
        if not isinstance(provided, list) or not all(isinstance(ref, str) for ref in provided):
            return False, f"citations.{key} must be an array of locations"
        if not all(any(citation_covers(ref, location) for ref in provided) for location in required):
            return False, f"citations.{key} lacks a required source location"
    return True, "correct"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Verify evidence in a pinned Django checkout")
    parser.add_argument("--task", choices=TASKS, help="Task ID to grade")
    parser.add_argument("--answer-file", type=Path, help="File containing one Codex final answer")
    args = parser.parse_args()
    if bool(args.task) != bool(args.answer_file):
        parser.error("--task and --answer-file must be provided together")
    if args.source:
        verify_source(args.source)
        print(f"Source verified: {len(TASKS)} tasks at {MANIFEST['base_commit']}")
    if args.task:
        passed, reason = grade(args.task, args.answer_file.read_text())
        print(f"{args.task}: {'PASS' if passed else 'FAIL'} ({reason})")
        raise SystemExit(0 if passed else 1)
    if not args.source:
        parser.error("provide --source, or --task with --answer-file")


if __name__ == "__main__":
    main()
