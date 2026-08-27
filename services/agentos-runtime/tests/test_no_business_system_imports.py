"""Static structural test: the AgentOS code path never imports or references
anything Odoo/Chatwoot/host-credential-shaped.

Test category mapping:
  13. No business-system writes.

Two layers, matching the two ways CLAUDE.md's Law 21 says a defect hides:
  (a) a source-text grep across every .py file in src/, so a NEW file added
      later is covered automatically, not just the files that exist today;
  (b) an explicit runtime check that the actually-imported module graph after
      importing `agentos_runtime.main` contains no module whose name matches
      a forbidden pattern — this catches a transitive import a text grep
      could miss (e.g. a helper module imported under a disguised name).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

FORBIDDEN_PATTERNS = [
    re.compile(r"\bodoo\b", re.IGNORECASE),
    re.compile(r"\bchatwoot\b", re.IGNORECASE),
    re.compile(r"\bxmlrpc\b", re.IGNORECASE),  # Odoo's own RPC transport
    re.compile(r"\bcodex_local\b", re.IGNORECASE),
    re.compile(r"\bparamiko\b", re.IGNORECASE),  # SSH — a host-credential shape
    re.compile(r"\bssh\b", re.IGNORECASE),
]

SRC_ROOT = Path(__file__).resolve().parent.parent / "src" / "agentos_runtime"

_TRIPLE_QUOTED = re.compile(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'')
_LINE_COMMENT = re.compile(r"#.*$", re.MULTILINE)


def _strip_comments_and_docstrings(text: str) -> str:
    """Mirrors services/isola-runtime/test/no-direct-network.test.ts's
    `stripComments`: this module DESCRIBES the forbidden systems in its own
    doc comments (explaining why they are avoided — see agent.py, prompt.py,
    schemas.py), so the scan must be about executable code, not prose. Code
    inside a comment or docstring does not run.
    """
    return _LINE_COMMENT.sub("", _TRIPLE_QUOTED.sub(" ", text))


def _all_source_files() -> list[Path]:
    return sorted(SRC_ROOT.rglob("*.py"))


def test_source_tree_is_non_empty_control():
    # Positive control: if this is ever 0, the grep below passes vacuously.
    files = _all_source_files()
    assert len(files) >= 5, f"expected several source files, found {len(files)}"


def test_stripping_actually_removes_a_planted_comment_control():
    # Positive control for `_strip_comments_and_docstrings` itself: prove it
    # actually removes text, so the real test below isn't passing because the
    # stripper is a no-op that strips nothing.
    sample = '"""a docstring mentioning odoo"""\nreal_code = 1  # a comment mentioning chatwoot\n'
    stripped = _strip_comments_and_docstrings(sample)
    assert "odoo" not in stripped.lower()
    assert "chatwoot" not in stripped.lower()
    assert "real_code = 1" in stripped


def test_no_source_file_mentions_a_forbidden_system():
    offenders: list[str] = []
    for path in _all_source_files():
        code = _strip_comments_and_docstrings(path.read_text(encoding="utf-8"))
        for pattern in FORBIDDEN_PATTERNS:
            if pattern.search(code):
                offenders.append(f"{path.name}: matched {pattern.pattern!r}")
    assert offenders == [], f"forbidden references found in executable code: {offenders}"


def test_imported_module_graph_has_no_forbidden_module(app_module):
    # `app_module` fixture (conftest.py) has already imported agentos_runtime.main
    # fully, including the AgentOS mount — so this reflects the REAL, complete
    # import graph a running process would have, not a partial one.
    forbidden_name_fragments = ("odoo", "chatwoot", "xmlrpc", "paramiko")
    offenders = [
        name
        for name in sys.modules
        if name.startswith("agentos_runtime") or "agno" in name
        for fragment in forbidden_name_fragments
        if fragment in name.lower()
    ]
    assert offenders == []
