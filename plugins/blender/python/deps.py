# Copyright 2026 Frameshell contributors
# SPDX-License-Identifier: Apache-2.0
#
# Run by the @frameshell/blender adapter inside the user's Blender:
#   blender -b --factory-startup -Y <file.blend> --python-exit-code 1 -P deps.py -- '{"out": "<file.json>"}'
# Writes the absolute paths of the files the .blend references (libraries, images, caches) as {"paths": [...]}.
# The adapter keeps the ones inside the project: editing one re-renders the clip. Never saves the .blend.

import json
import sys

import bpy


def main():
    request = json.loads(sys.argv[sys.argv.index("--") + 1])
    # local=False keeps linked libraries in the list; packed=False leaves out what is stored inside the file.
    paths = bpy.utils.blend_paths(absolute=True, packed=False, local=False)
    with open(request["out"], "w", encoding="utf-8") as out:
        json.dump({"paths": list(paths)}, out)


main()
