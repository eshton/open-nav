#!/usr/bin/env python3
"""Re-vendor the official NAV schemas, fixtures and message catalogues.

The XSDs, sample XMLs and validation message catalogues under `schemas/` and
`conformance/` are copied verbatim from NAV's public repositories. They are
never edited by hand: run this script to refresh them, then review the diff.

    python3 scripts/vendor_schemas.py --check   # fail if vendored copy is stale
    python3 scripts/vendor_schemas.py           # refresh in place

Sources:
  * https://github.com/nav-gov-hu/Online-Invoice  (OSA 3.0 schemas + samples)  — MIT (c) NAV
  * https://github.com/nav-gov-hu/Common          (NTCA 1.0 common.xsd)        — MIT (c) NAV
  * https://github.com/nav-gov-hu/eVAT            (EAR 2.0 eÁFA M2M schemas)    — no stated licence
  * https://github.com/nav-gov-hu/eRECEIPT        (ERECEIPT 1.1 eNyugta M2M)    — no stated licence

The eVAT and eRECEIPT repositories carry no licence file. They are vendored
under NAV's evident org-wide MIT intent — see schemas/NOTICE.md — not under an
explicit grant. If NAV declines to license them, drop those two sources.
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

# eÁFA (eVAT) and eNyugta (eReceipt) M2M schemas. Neither repository carries a
# licence file, unlike Online-Invoice and Common; see schemas/NOTICE.md.
EVAT_REPO = 'https://github.com/nav-gov-hu/eVAT'
ERECEIPT_REPO = 'https://github.com/nav-gov-hu/eRECEIPT'
UNLICENSED_NOTICE = 'No stated licence; vendored per NAV org-wide MIT intent - see schemas/NOTICE.md'

# (source_path, vendored_path) pairs, copied verbatim. The layout is preserved
# where the schemas use relative imports so those imports still resolve.
#
# eVAT: earAPI/earBase/earData form the M2M closure; they import NTCA common by
# namespace only (catalog-resolved, no schemaLocation), so no co-located copy is
# needed. formData is the legacy ÁNYK form schema (EAR/1.0/base) and is skipped.
EVAT_FILES = [
    ('src/schemas/hu/gov/nav/vdr/earAPI.xsd', 'schemas/EAR/2.0/earAPI.xsd'),
    ('src/schemas/hu/gov/nav/vdr/earBase.xsd', 'schemas/EAR/2.0/earBase.xsd'),
    ('src/schemas/hu/gov/nav/vdr/earData.xsd', 'schemas/EAR/2.0/earData.xsd'),
    # The standard tax-code catalogue (VAT ledger classification codes),
    # generated into typed data by scripts/generate_tax_codes.py.
    (
        'docs/standard_adokod/TAX_CODE_CATALOG_20260904_extended.xlsx',
        'schemas/EAR/tax-code-catalog/TAX_CODE_CATALOG_20260904_extended.xlsx',
    ),
]
# eReceipt: the 1.1 API set plus the 1.0 sub-schemas it imports via ../1.0/.
# Vendoring 1.1 -> ERECEIPT/1.1 and 1.0 -> ERECEIPT/1.0 keeps those relative
# references valid. receipt_datareport, eDocumentStore, eCustomerApp and
# NaviNotification are separate interfaces, not needed for the manage/query
# receipt client, and are left for a later pass.
ERECEIPT_FILES = [
    ('xsd/1.1/eReceipt/1.1/eReceiptApi.xsd', 'schemas/ERECEIPT/1.1/eReceiptApi.xsd'),
    ('xsd/1.1/eReceipt/1.1/eReceiptBase.xsd', 'schemas/ERECEIPT/1.1/eReceiptBase.xsd'),
    ('xsd/1.1/eReceipt/1.1/communicationData.xsd', 'schemas/ERECEIPT/1.1/communicationData.xsd'),
    ('xsd/1.1/eReceipt/1.1/documentData.xsd', 'schemas/ERECEIPT/1.1/documentData.xsd'),
    ('xsd/1.1/eReceipt/1.1/documentMessage.xsd', 'schemas/ERECEIPT/1.1/documentMessage.xsd'),
    ('xsd/1.1/eReceipt/1.1/reportMessage.xsd', 'schemas/ERECEIPT/1.1/reportMessage.xsd'),
    ('xsd/1.1/eReceipt/1.0/common.xsd', 'schemas/ERECEIPT/1.0/common.xsd'),
    ('xsd/1.1/eReceipt/1.0/invoiceApi.xsd', 'schemas/ERECEIPT/1.0/invoiceApi.xsd'),
    ('xsd/1.1/eReceipt/1.0/invoiceBase.xsd', 'schemas/ERECEIPT/1.0/invoiceBase.xsd'),
    ('xsd/1.1/eReceipt/1.0/invoiceData.xsd', 'schemas/ERECEIPT/1.0/invoiceData.xsd'),
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
        evat, ereceipt = os.path.join(tmp, 'evat'), os.path.join(tmp, 'ereceipt')
        clone(OSA_REPO, osa)
        clone(COMMON_REPO, common)
        clone(EVAT_REPO, evat)
        clone(ERECEIPT_REPO, ereceipt)
        osa_revision = run('git', '-C', osa, 'rev-parse', 'HEAD').strip()
        evat_revision = run('git', '-C', evat, 'rev-parse', 'HEAD').strip()
        ereceipt_revision = run('git', '-C', ereceipt, 'rev-parse', 'HEAD').strip()
        subprocess.run(
            ['git', '-C', common, 'fetch', '--depth', '1', 'origin',
             f'refs/tags/{COMMON_REVISION}:refs/tags/{COMMON_REVISION}'],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

        osa_files: list[dict] = []
        common_files: list[dict] = []
        evat_files: list[dict] = []
        ereceipt_files: list[dict] = []
        manifest = {
            'generated_by': 'scripts/vendor_schemas.py',
            'note': 'Vendored verbatim from the official NAV repositories. Do not edit by hand.',
            'sources': [
                {'repo': OSA_REPO, 'revision': osa_revision,
                 'licence': 'MIT (c) Nemzeti Ado- es Vamhivatal', 'files': osa_files},
                {'repo': COMMON_REPO, 'revision': COMMON_REVISION,
                 'licence': 'MIT (c) Nemzeti Ado- es Vamhivatal', 'files': common_files},
                {'repo': EVAT_REPO, 'revision': evat_revision,
                 'licence': UNLICENSED_NOTICE, 'files': evat_files},
                {'repo': ERECEIPT_REPO, 'revision': ereceipt_revision,
                 'licence': UNLICENSED_NOTICE, 'files': ereceipt_files},
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

        for src_rel, dest_rel in EVAT_FILES:
            place(os.path.join(evat, src_rel), dest_rel, src_rel, evat_files)
        for src_rel, dest_rel in ERECEIPT_FILES:
            place(os.path.join(ereceipt, src_rel), dest_rel, src_rel, ereceipt_files)

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
                # README.md, known-issues.md and NOTICE.md are hand-authored
                # (not produced into the staging tree), so exclude them from the
                # drift comparison rather than have them always read as stale.
                # NAV-LICENCE.md is vendored and is intentionally not excluded.
                ['diff', '-r', '-q',
                 '-x', 'README.md', '-x', 'known-issues.md', '-x', 'NOTICE.md',
                 os.path.join(ROOT, sub), os.path.join(staging, sub)],
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
