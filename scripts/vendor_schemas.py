#!/usr/bin/env python3
"""Re-vendor the official NAV schemas, fixtures and message catalogues.

The XSDs, sample XMLs and validation message catalogues under `schemas/` and
`conformance/` are copied verbatim from NAV's public repositories. They are
never edited by hand: run this script to refresh them, then review the diff.

    python3 scripts/vendor_schemas.py --check   # fail if vendored copy is stale
    python3 scripts/vendor_schemas.py           # refresh in place

Sources (both MIT licensed, (c) Nemzeti Adó- és Vámhivatal):
  * https://github.com/nav-gov-hu/Online-Invoice  (OSA 3.0 schemas + samples)
  * https://github.com/nav-gov-hu/Common          (NTCA 1.0 common.xsd)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

OSA_REPO = 'https://github.com/nav-gov-hu/Online-Invoice'
COMMON_REPO = 'https://github.com/nav-gov-hu/Common'
# NTCA 1.0 final. Note that NAV's own OSA 3.0 catalog.xml points at the older
# Common-1.0.RC3 tag, which predates RequestPageType/ResponsePageType — types
# that invoiceApi.xsd 3.0 references. RC3 therefore cannot resolve the 3.0 API
# schema; common-1.0.0 can. See schemas/README.md.
COMMON_REVISION = 'common-1.0.0'
COMMON_XSD_PATH = (
    'schemas/src/main/resources/xsd/hu/gov/nav/schemas/NTCA/1.0/common/common.xsd'
)

SCHEMA_FILES = [
    'invoiceApi.xsd',
    'invoiceData.xsd',
    'invoiceBase.xsd',
    'invoiceAnnulment.xsd',
    'serviceMetrics.xsd',
    'catalog.xml',
    'CHANGELOG_3.0.md',
    'CHANGELOG_2.0.md',
]
I18N_FILES = [
    f'{kind}_{lang}_public.properties'
    for lang in ('hu', 'en', 'de')
    for kind in ('validations', 'messages')
]
FIXTURE_SETS = [
    ('api_samples', 'sample/API sample', 'conformance/api-samples'),
    ('data_samples', 'sample/Data sample', 'conformance/data-samples'),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sha256(path: str) -> str:
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def slugify(name: str) -> str:
    """NAV's sample filenames carry spaces and accents; normalise for tooling.

    The original name is preserved in conformance/fixtures.json so every
    fixture stays traceable to its upstream file.
    """
    stem, ext = os.path.splitext(name)
    stem = unicodedata.normalize('NFKD', stem).encode('ascii', 'ignore').decode()
    stem = re.sub(r'[^A-Za-z0-9]+', '-', stem).strip('-').lower()
    return f'{stem}{ext.lower()}'


def clone(repo: str, dest: str) -> None:
    env = dict(os.environ, GIT_LFS_SKIP_SMUDGE='1')
    subprocess.run(
        ['git', 'clone', '--depth', '1', repo, dest],
        check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def vendor(dest_root: str) -> tuple[dict, dict]:
    with tempfile.TemporaryDirectory() as tmp:
        osa, common = os.path.join(tmp, 'osa'), os.path.join(tmp, 'common')
        clone(OSA_REPO, osa)
        clone(COMMON_REPO, common)
        osa_revision = run('git', '-C', osa, 'rev-parse', 'HEAD').strip()
        subprocess.run(
            ['git', '-C', common, 'fetch', '--depth', '1', 'origin',
             f'refs/tags/{COMMON_REVISION}:refs/tags/{COMMON_REVISION}'],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

        osa_files: list[dict] = []
        common_files: list[dict] = []
        manifest = {
            'generated_by': 'scripts/vendor_schemas.py',
            'note': 'Vendored verbatim from the official NAV repositories. Do not edit by hand.',
            'sources': [
                {'repo': OSA_REPO, 'revision': osa_revision,
                 'licence': 'MIT (c) Nemzeti Ado- es Vamhivatal', 'files': osa_files},
                {'repo': COMMON_REPO, 'revision': COMMON_REVISION,
                 'licence': 'MIT (c) Nemzeti Ado- es Vamhivatal', 'files': common_files},
            ],
        }
        fixtures: dict[str, list[dict]] = {label: [] for label, _, _ in FIXTURE_SETS}

        def place(src: str, rel_dest: str, source_path: str, files: list[dict]) -> None:
            dst = os.path.join(dest_root, rel_dest)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            files.append({'source_path': source_path, 'vendored_path': rel_dest,
                          'sha256': sha256(dst)})

        for name in SCHEMA_FILES:
            rel = f'src/schemas/nav/gov/hu/OSA/{name}'
            place(os.path.join(osa, rel), f'schemas/OSA/3.0/{name}', rel, osa_files)
        for name in I18N_FILES:
            rel = f'src/i18n/{name}'
            place(os.path.join(osa, rel), f'schemas/i18n/{name}', rel, osa_files)

        for label, sub, out in FIXTURE_SETS:
            for name in sorted(os.listdir(os.path.join(osa, sub))):
                if not name.lower().endswith('.xml'):
                    continue
                target = slugify(name)
                rel_dest = f'{out}/{target}'
                place(os.path.join(osa, sub, name), rel_dest, f'{sub}/{name}', osa_files)
                fixtures[label].append({
                    'original_name': name,
                    'file': target,
                    'sha256': sha256(os.path.join(dest_root, rel_dest)),
                })

        blob = run('git', '-C', common, 'show', f'{COMMON_REVISION}:{COMMON_XSD_PATH}')
        dst = os.path.join(dest_root, 'schemas/NTCA/1.0/common.xsd')
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8') as handle:
            handle.write(blob)
        common_files.append({'source_path': COMMON_XSD_PATH,
                             'vendored_path': 'schemas/NTCA/1.0/common.xsd',
                             'sha256': sha256(dst)})

        shutil.copy2(os.path.join(osa, 'LICENCE.md'),
                     os.path.join(dest_root, 'schemas/NAV-LICENCE.md'))
        return manifest, fixtures


def write_json(path: str, payload: object) -> None:
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write('\n')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true',
                        help='vendor into a temporary tree and diff against the committed copy')
    args = parser.parse_args()

    if not args.check:
        manifest, fixtures = vendor(ROOT)
        write_json(os.path.join(ROOT, 'schemas/sources.json'), manifest)
        write_json(os.path.join(ROOT, 'conformance/fixtures.json'), fixtures)
        print('Vendored NAV schemas and fixtures. Review the diff before committing.')
        return 0

    with tempfile.TemporaryDirectory() as staging:
        manifest, fixtures = vendor(staging)
        write_json(os.path.join(staging, 'schemas/sources.json'), manifest)
        write_json(os.path.join(staging, 'conformance/fixtures.json'), fixtures)
        stale = []
        for sub in ('schemas', 'conformance'):
            result = subprocess.run(
                ['diff', '-r', '-q', os.path.join(ROOT, sub), os.path.join(staging, sub)],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                stale.append(result.stdout.strip())
        if stale:
            print('Vendored NAV files are out of date:', file=sys.stderr)
            print('\n'.join(stale), file=sys.stderr)
            print('\nRun: python3 scripts/vendor_schemas.py', file=sys.stderr)
            return 1
        print('Vendored NAV files match upstream.')
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
