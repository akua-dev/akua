"""Execution-root paths of this repository's sources.

This tree builds standalone and as a module of a larger workspace, where its
files live under `external/<repository>/`. Paths handed to tools (Cargo's
CARGO_MANIFEST_DIR, ...) are therefore derived from this repository's root
instead of being written out.
"""

_ROOT = Label("//:BUILD.bazel").workspace_root

def source_directory(path):
    """The execution-root path of `path`, a directory of this repository."""
    return _ROOT + "/" + path if _ROOT else path
