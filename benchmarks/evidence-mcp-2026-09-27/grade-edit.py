"""Hidden behavioral checks for bounded defects injected into pinned public sources."""

import sys
from pathlib import Path


def check(task_id):
    if task_id == "dj-filename-fix":
        from django.core.exceptions import SuspiciousFileOperation
        from django.utils.text import get_valid_filename

        assert get_valid_filename("  hello world.txt  ") == "hello_world.txt"
        assert get_valid_filename("john's portrait in 2004.jpg") == "johns_portrait_in_2004.jpg"
        assert get_valid_filename("a b  c.txt") == "a_b__c.txt"
        for invalid in ["", " . ", ".."]:
            try:
                get_valid_filename(invalid)
            except SuspiciousFileOperation:
                pass
            else:
                raise AssertionError(f"Expected SuspiciousFileOperation for {invalid!r}")
    elif task_id == "dj-slugify-fix":
        from django.utils.text import slugify

        assert slugify("One--- Two") == "one-two"
        assert slugify("one - --two") == "one-two"
        assert slugify("Über Café") == "uber-cafe"
        assert slugify("你好 世界", allow_unicode=True) == "你好-世界"
    elif task_id == "pt-ansi-fix":
        from _pytest.logging import _remove_ansi_escape_sequences

        assert _remove_ansi_escape_sequences("\x1b[31mred\x1b[0m") == "red"
        assert _remove_ansi_escape_sequences("plain \x1b[1;34mblue\x1b[0m end") == "plain blue end"
        assert _remove_ansi_escape_sequences("already plain") == "already plain"
    elif task_id == "pt-pattern-fix":
        from _pytest.python import path_matches_patterns

        assert path_matches_patterns(Path("tests/test_widget.py"), ["test_*.py", "*_test.py"])
        assert path_matches_patterns(Path("tests/widget_test.py"), ["test_*.py", "*_test.py"])
        assert not path_matches_patterns(Path("tests/widget.py"), ["test_*.py", "*_test.py"])
    else:
        raise ValueError(f"Unknown edit task: {task_id}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: grade-edit.py TASK_ID")
    check(sys.argv[1])
    print("PASS")
