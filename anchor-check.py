#!/usr/bin/env python3
"""Verify every file:line and symbol citation in the callelo memory store
against a given git ref (default origin/main).

Emits a report grouped by defect class. Read-only; touches nothing.
"""
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import os
MEM = Path(os.environ.get(
    "ANCHOR_MEM_DIR",
    "/Users/daniacono/.claude/projects/-Volumes-FastSSD-code-callelo/memory"))
REPO = "/Volumes/FastSSD/code/callelo"
REF = sys.argv[1] if len(sys.argv) > 1 else "origin/main"

TOP = r"(?:src|e2e|scripts|docs|prisma|\.github|\.claude)"
# longest-first so `ts` cannot match inside `.tsx` and `js` inside `.json`;
# the lookahead makes the ordering non-load-bearing.
EXT = r"(?:tsx|ts|jsx|json|mjs|cjs|js|sh|md|yaml|yml|sql|prisma|css)(?![A-Za-z])"
# full paths, optional ":123" / "~:123" / ":123-456"
PATH_RE = re.compile(rf"{TOP}/[A-Za-z0-9_@.\-/\[\]()]+?\.{EXT}(?:\s*~?:\s*(\d+)(?:-(\d+))?)?")
# bare basenames in backticks, e.g. `rubric-editor.tsx`, `deck-upload-wizard.tsx:379`
BARE_RE = re.compile(rf"`([A-Za-z0-9_.\-]+\.{EXT})(?::(\d+))?`")
# backticked identifiers that look like code symbols
SYM_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]{3,})`")

STOPWORDS = {
    "true", "false", "null", "undefined", "main", "status", "error", "params",
    "test", "tests", "npm", "npx", "bash", "json", "yaml", "grep", "echo",
    "READY", "PLATFORM", "CRITICAL", "HIGH", "MEDIUM", "LOW", "PASS", "FAIL",
    "IMPORTING", "ACCEPTED", "REJECTED", "SELECT", "WHERE", "FATAL", "PARTIAL",
    "sales", "management", "opus", "sonnet", "codex", "roster", "objection",
}


def sh(args):
    return subprocess.run(args, cwd=REPO, capture_output=True, text=True)


def blob_exists(path):
    return sh(["git", "cat-file", "-e", f"{REF}:{path}"]).returncode == 0


def line_count(path):
    r = sh(["git", "show", f"{REF}:{path}"])
    return len(r.stdout.splitlines()) if r.returncode == 0 else None


def find_basename(name):
    r = sh(["git", "ls-tree", "-r", "--name-only", REF])
    return [l for l in r.stdout.splitlines() if l.rsplit("/", 1)[-1] == name]


def symbol_hits(sym):
    r = sh(["git", "grep", "-l", "-F", "-w", sym, REF, "--",
            "src", "e2e", "scripts", "prisma", "docs", ".github"])
    return [l for l in r.stdout.splitlines() if l.strip()]


bad_path, bad_line, bad_bare, bad_sym = [], [], [], []
ok = defaultdict(int)
path_cache, sym_cache, bare_cache = {}, {}, {}

files = sorted(p for p in MEM.glob("*.md") if p.name != "MEMORY.md")
for f in files:
    text = f.read_text()

    for m in PATH_RE.finditer(text):
        raw = m.group(0)
        path = re.split(r"\s*~?:", raw)[0].rstrip(".,;)")
        start = m.group(1)
        if path not in path_cache:
            path_cache[path] = (blob_exists(path), line_count(path))
        exists, lines = path_cache[path]
        if not exists:
            bad_path.append((f.name, path))
        else:
            ok["path"] += 1
            if start and lines is not None and int(start) > lines:
                bad_line.append((f.name, path, int(start), lines))
            elif start:
                ok["line"] += 1

    for m in BARE_RE.finditer(text):
        name, ln = m.group(1), m.group(2)
        if "/" in name:
            continue
        if name not in bare_cache:
            bare_cache[name] = find_basename(name)
        hits = bare_cache[name]
        if not hits:
            bad_bare.append((f.name, name))
        else:
            ok["bare"] += 1
            if ln:
                lc = line_count(hits[0])
                if lc is not None and int(ln) > lc:
                    bad_line.append((f.name, hits[0], int(ln), lc))

    for m in SYM_RE.finditer(text):
        sym = m.group(1)
        if sym in STOPWORDS or sym.lower() == sym and "_" not in sym and len(sym) < 8:
            continue
        if not re.search(r"[a-z][A-Z]|_", sym):
            continue
        if sym not in sym_cache:
            sym_cache[sym] = symbol_hits(sym)
        if not sym_cache[sym]:
            bad_sym.append((f.name, sym))
        else:
            ok["sym"] += 1

print(f"ANCHOR CHECK vs {REF}")
print(f"memories scanned: {len(files)}")
print(f"verified OK: {ok['path']} full paths ({ok['line']} with line numbers), "
      f"{ok['bare']} bare filenames, {ok['sym']} symbols\n")

def dump(title, rows, fmt):
    print(f"===== {title}: {len(rows)} =====")
    for r in sorted(set(rows)):
        print("  " + fmt(r))
    if not rows:
        print("  (none)")
    print()

dump("BROKEN PATHS (file does not exist on ref)", bad_path,
     lambda r: f"{r[0]:52} {r[1]}")
dump("LINE BEYOND EOF (file exists, cited line does not)", bad_line,
     lambda r: f"{r[0]:52} {r[1]}:{r[2]} (file has {r[3]} lines)")
dump("BARE FILENAME NOT FOUND", bad_bare,
     lambda r: f"{r[0]:52} {r[1]}")
dump("SYMBOL NOT FOUND", bad_sym,
     lambda r: f"{r[0]:52} {r[1]}")
