"""Mount a DMG read-only, copy its application and validate the installed bundle."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('dmg', type=Path)
parser.add_argument('--keep-copy', action='store_true')
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='peek-install-check-'))
mount = root / 'volume'
mount.mkdir()
mounted = False
try:
    subprocess.run(['hdiutil', 'attach', str(args.dmg.resolve()), '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', str(mount)], check=True, capture_output=True)
    mounted = True
    destination = root / 'installed' / 'Peek Desktop.app'
    destination.parent.mkdir()
    subprocess.run(['ditto', str(mount / 'Peek Desktop.app'), str(destination)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(destination)], check=True)
    with (destination / 'Contents/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    extensions = {ext for item in info.get('CFBundleDocumentTypes', []) for ext in item.get('CFBundleTypeExtensions', [])}
    assert info['CFBundleIdentifier'] == 'local.peek.desktop'
    assert {'peek', 'peekbundle'} <= extensions
    assert (destination / 'Contents/Resources' / info['CFBundleIconFile']).is_file()
    assert (destination / 'Contents/MacOS' / info['CFBundleExecutable']).is_file()
    print(json.dumps({'version': info['CFBundleShortVersionString'], 'fileTypes': sorted(extensions), 'copiedApp': str(destination) if args.keep_copy else 'validated temporary installation'}, ensure_ascii=False))
finally:
    if mounted:
        subprocess.run(['hdiutil', 'detach', str(mount)], check=True, capture_output=True)
    if not args.keep_copy:
        shutil.rmtree(root)
