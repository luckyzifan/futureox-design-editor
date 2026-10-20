#!/usr/bin/env python3
"""Validate shared-style and embedded-font definitions against official schema.
This deliberately does not certify the whole Sketch archive or native app UI.
Usage: python3 testing/validate-sketch-shared-resources.py schema.json file.sketch
"""
import json, sys, zipfile
from jsonschema import Draft7Validator
schema = json.load(open(sys.argv[1], encoding='utf-8'))
with zipfile.ZipFile(sys.argv[2]) as archive:
    document = json.loads(archive.read('document.json'))
    counts = {}
    for field, definition in [('layerStyles','SharedStyleContainer'), ('layerTextStyles','SharedTextStyleContainer')]:
        validator = Draft7Validator({'$ref':'#/definitions/'+definition, 'definitions':schema['definitions']})
        validator.validate(document[field])
        counts[field] = len(document[field]['objects'])
    validator = Draft7Validator({'$ref':'#/definitions/FontRef', 'definitions':schema['definitions']})
    for reference in document.get('fontReferences', []): validator.validate(reference)
    counts['fontReferences'] = len(document.get('fontReferences', []))
    definitions = {s['do_objectID'] for key in ['layerStyles','layerTextStyles'] for s in document[key]['objects']}
    links = 0
    def inspect(layer):
        global links
        if 'sharedStyleID' in layer:
            assert layer['sharedStyleID'] in definitions, 'Dangling native shared-style ID'
            links += 1
        assert 'sharedStyleID' not in layer.get('style', {}), 'Style ID belongs on layer'
        for child in layer.get('layers', []): inspect(child)
    for name in archive.namelist():
        if name.startswith('pages/') and name.endswith('.json'): inspect(json.loads(archive.read(name)))
    counts['resolvedLayerStyleReferences'] = links
    print(json.dumps({'archive':sys.argv[2], 'scope':'shared-resource schemas and layer references only','valid':True,'counts':counts},indent=2))
