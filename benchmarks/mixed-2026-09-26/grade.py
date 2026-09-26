"""Strict public-fixture answer grader and fixture evidence check."""

import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "manifest.json").read_text())
TASKS = {task["id"]: task for task in MANIFEST["tasks"]}


def verify_fixture():
    for task in TASKS.values():
        for location, expected in task.get("source_evidence", {}).items():
            path, line = location.rsplit(":", 1)
            actual = (HERE / "fixture" / path).read_text().splitlines()[int(line) - 1].strip()
            if actual != expected:
                raise ValueError(f"{task['id']} {location}: {actual!r} != {expected!r}")


def grade_read(task, raw):
    try:
        obj = json.loads(raw.strip())
    except (ValueError, TypeError) as exc:
        return False, f"invalid JSON: {exc}"
    if not isinstance(obj, dict) or set(obj) != {"answer", "citations"}:
        return False, "top-level keys must be answer and citations"
    if obj["answer"] != task["expected_answer"]:
        return False, "answer mismatch"
    citations = obj["citations"]
    if not isinstance(citations, dict) or set(citations) != set(task["required_citations"]):
        return False, "citation keys mismatch"
    for key, required in task["required_citations"].items():
        given = citations[key]
        if not isinstance(given, list) or not all(isinstance(item, str) for item in given):
            return False, f"citations.{key} must be a string array"
        if not set(required).issubset(given):
            return False, f"citations.{key} misses exact required lines"
    return True, "correct"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-fixture", action="store_true")
    parser.add_argument("--task", choices=TASKS)
    parser.add_argument("--answer-file", type=Path)
    args = parser.parse_args()
    if args.verify_fixture:
        verify_fixture()
        print(f"Fixture verified: {len(TASKS)} tasks")
    if args.task:
        if not args.answer_file:
            parser.error("--answer-file is required with --task")
        if TASKS[args.task]["type"] == "code_edit":
            parser.error("Code edits are graded by the runner's hidden behavior checks")
        passed, detail = grade_read(TASKS[args.task], args.answer_file.read_text())
        print(f"{args.task}: {'PASS' if passed else 'FAIL'} ({detail})")
        raise SystemExit(0 if passed else 1)
    if not args.verify_fixture:
        parser.error("provide --verify-fixture or --task and --answer-file")


if __name__ == "__main__":
    main()
