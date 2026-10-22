#!/usr/bin/env python3
"""Restore guarded source files only. This does NOT downgrade any database."""
from pathlib import Path
import sys
from apply_increment import perform
import json
if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: python3 rollback_increment.py /absolute/path/to/Core')
        print(json.dumps(perform(Path(__file__).parent, sys.argv[1], 'rollback'), indent=2))
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
