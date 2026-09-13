#!/usr/bin/env python3
"""Watch the upstream NAV repositories for changes we have not vendored yet.

`vendor_schemas.py --check` catches drift in the specific files we copy. This
catches the step before that: a new commit, release or tag on a NAV repo — even
one that touches files we do not vendor yet (a new schema, a new interface
version). It compares the revisions recorded in `schemas/sources.json` (what we
last vendored) against each repository's current default-branch head, and lists
the latest release/tag for visibility.

    python3 scripts/check_upstream.py            # human-readable report
    python3 scripts/check_upstream.py --format md # Markdown, for a GitHub issue

Exit status is non-zero when a tracked repository has moved ahead of the
revision we vendored, so CI can act on it. Repositories pinned to a fixed tag
(Common, deliberately held at common-1.0.0) are reported for information only
and never fail the run.

Uses the GitHub REST API with no third-party dependencies. Set GITHUB_TOKEN to
raise the rate limit and read private data; it works unauthenticated too.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(ROOT, 'schemas', 'sources.json')

# Repositories intentionally pinned to a fixed tag rather than tracking HEAD.
# See vendor_schemas.py (COMMON_REVISION) for why Common is held at 1.0.0.
PINNED_REPOS = {'Common'}

HEX40 = re.compile(r'^[0-9a-f]{40}$')


def api(path: str) -> object | None:
    """GET a GitHub REST endpoint; return parsed JSON, or None on 404."""
    request = urllib.request.Request(f'https://api.github.com{path}')
    request.add_header('Accept', 'application/vnd.github+json')
    request.add_header('X-GitHub-Api-Version', '2022-11-28')
    request.add_header('User-Agent', 'open-nav-upstream-monitor')
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        request.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def owner_repo(url: str) -> tuple[str, str]:
    owner, repo = url.rstrip('/').split('/')[-2:]
    return owner, repo.removesuffix('.git')


def head_sha(owner: str, repo: str) -> str:
    commits = api(f'/repos/{owner}/{repo}/commits?per_page=1')
    if not commits:
        raise RuntimeError(f'no commits returned for {owner}/{repo}')
    return commits[0]['sha']


def latest_ref(owner: str, repo: str) -> str | None:
    """The latest release tag, or the newest tag if there are no releases."""
    release = api(f'/repos/{owner}/{repo}/releases/latest')
    if isinstance(release, dict) and release.get('tag_name'):
        return f"release {release['tag_name']}"
    tags = api(f'/repos/{owner}/{repo}/tags?per_page=1')
    if tags:
        return f'tag {tags[0]["name"]}'
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--format', choices=('text', 'md'), default='text')
    args = parser.parse_args()

    with open(SOURCES, encoding='utf-8') as handle:
        sources = json.load(handle)

    changed: list[str] = []
    lines: list[str] = []

    for source in sources['sources']:
        owner, repo = owner_repo(source['repo'])
        vendored = source['revision']
        pinned = repo in PINNED_REPOS or not HEX40.match(vendored)

        ref = latest_ref(owner, repo)
        ref_note = f', latest {ref}' if ref else ''

        if pinned:
            lines.append(f'- {owner}/{repo}: pinned at {vendored}{ref_note} (not tracked)')
            continue

        head = head_sha(owner, repo)
        if head == vendored:
            lines.append(f'- {owner}/{repo}: up to date at {head[:12]}{ref_note}')
        else:
            changed.append(repo)
            lines.append(
                f'- **{owner}/{repo}: MOVED** — vendored {vendored[:12]}, '
                f'upstream {head[:12]}{ref_note}'
            )

    if args.format == 'md':
        header = (
            '### NAV upstream changed\n\n'
            'A tracked NAV repository has moved ahead of the revision we vendored. '
            'Re-run `python3 scripts/vendor_schemas.py`, review the diff, regenerate '
            '(`pnpm codegen`) and cut a release.\n'
            if changed
            else '### NAV upstream check\n\nAll tracked repositories are up to date.\n\n'
        )
        print(header + '\n'.join(lines))
    else:
        print('\n'.join(lines))

    if changed:
        print(f'\nCHANGED: {", ".join(sorted(changed))}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
