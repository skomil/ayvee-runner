#!/usr/bin/env bash
# Manually build and publish ayvee-runner-client.
#
#   ./scripts/publish.sh            # dry run: build and check, publish nothing
#   ./scripts/publish.sh testpypi   # publish to TestPyPI
#   ./scripts/publish.sh pypi       # publish to PyPI
#
# Needs a token in UV_PUBLISH_TOKEN (or ~/.pypirc). CI publishes without a
# token via Trusted Publishing — see .github/workflows/publish.yml.
set -euo pipefail

target="${1:-check}"
cd "$(dirname "$0")/.."

version=$(python3 -c 'import tomllib,pathlib; print(tomllib.loads(pathlib.Path("pyproject.toml").read_text())["project"]["version"])')
echo "ayvee-runner-client ${version} -> ${target}"

uv sync --quiet
uv run ruff check .
uv run pytest tests/unit -q

rm -rf dist
uv build
uvx twine check dist/*

case "$target" in
  check)
    echo "Dry run complete; dist/ built but not uploaded."
    ;;
  testpypi)
    uv publish --publish-url https://test.pypi.org/legacy/
    ;;
  pypi)
    read -rp "Publish ${version} to PyPI? This cannot be undone. [y/N] " confirm
    [ "$confirm" = "y" ] || { echo "Aborted."; exit 1; }
    uv publish
    echo "Tag the release:  git tag v${version} && git push origin v${version}"
    ;;
  *)
    echo "usage: $0 [check|testpypi|pypi]" >&2
    exit 1
    ;;
esac
