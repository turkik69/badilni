#!/usr/bin/env bash
set -euo pipefail

# Run interactively once, after choosing a secure backup location.
if [[ $# -ne 1 ]]; then
  echo 'Usage: scripts/create-android-upload-key.sh /secure/backup/badilni-upload.jks' >&2
  exit 2
fi
command -v keytool >/dev/null || { echo 'JDK keytool is required' >&2; exit 2; }
key_path="$1"
if [[ -e "$key_path" ]]; then echo 'Refusing to overwrite an existing upload key' >&2; exit 1; fi
mkdir -p "$(dirname "$key_path")"
umask 077
keytool -genkeypair -v -keystore "$key_path" -alias badilni-upload -keyalg RSA -keysize 3072 -validity 10000 -storetype PKCS12
chmod 600 "$key_path"
printf 'Upload key created. Back up this file and its password separately. Never commit either one.\n'
