#!/bin/sh
# setup.sh — idempotent: clone the ragdepot lib and build its venv.
# Safe to re-run: existing clone/venv are reused, wheels refresh in place.
# Data in ~/.ragdepot-pi is never touched.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PY=${RAGDEPOT_SETUP_PYTHON:-python3.14}   # lib requires Python >= 3.14

if [ ! -d "$DIR/ragdepot/.git" ]; then
  git clone https://github.com/Origamify/ragdepot.git "$DIR/ragdepot"
fi

cd "$DIR/ragdepot"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
# Default: install only missing/changed deps (fast, mostly offline).
# Set RAGDEPOT_SETUP_UPGRADE=1 to also bump existing deps to latest.
PIP_FLAGS=--quiet
if [ "${RAGDEPOT_SETUP_UPGRADE:-0}" = 1 ]; then PIP_FLAGS="--quiet --upgrade"; fi
.venv/bin/pip install $PIP_FLAGS -r requirements.txt -e .

echo "setup ok: $(.venv/bin/python --version) @ $DIR/ragdepot/.venv"
