# Interrupted format diagnostic (excluded from the holdout)

The first full schedule was stopped after 34 completed runs on 12 read tasks in repetition 1. The original read grader compared the `value` field byte for byte with a bare symbol. It rejected correct, cited answers such as `django.utils.text.get_valid_filename` when the expected value was `get_valid_filename`, and complete explanatory sentences naming `fnmatch_ex`. Continuing that schedule would have priced formatting failures as task failures.

The archived [results.json](results.json) and traces retain those original grades. They are **diagnostic only**; none is included in the final paired comparison. We changed the general grader to accept a bounded occurrence of the expected identifier in a string for log and multi-file answers, while keeping exact source locations strict and requiring the same source citations. Unit tests cover qualified names, wrong names, and missing citations.

All 12 read tasks exposed in this diagnostic were replaced with previously unrun source questions and log correlations. The four edit tasks were not reached and remain in the final set. The final [manifest](../manifest.json) and runner were frozen before any run of the replacement tasks. This sequence is disclosed because the first two attempts to set up a valid evaluation found test-design errors rather than reliable product effects.
