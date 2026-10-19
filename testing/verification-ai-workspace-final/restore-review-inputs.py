#!/usr/bin/env python3
"""Materialize sanitized independent review sources outside the product repository."""
import argparse,json,pathlib
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--output',required=True);a=p.parse_args()
repo=pathlib.Path(a.repo).resolve();out=pathlib.Path(a.output).resolve();here=pathlib.Path(__file__).resolve().parent
if out==repo or repo in out.parents:raise SystemExit('Choose an output outside the repository')
manifest=json.loads((here/'external-review-inputs.json').read_text())
for record in manifest['inputs']:
    suffix=record['originalPath'].removeprefix('<batch>/')
    if suffix==record['originalPath'] or '..' in pathlib.PurePosixPath(suffix).parts:raise SystemExit('Unexpected review path')
    target=out/suffix;target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():raise SystemExit(f'Refusing to overwrite {target}')
    text=(here/record['sanitizedSource']).read_text().replace('<repo>',str(repo)).replace('<batch>',str(out))
    target.write_text(text)
    print(target)
