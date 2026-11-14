#!/bin/sh
# Mac / Linux:  ./start.sh      The first run sets everything up (a few minutes).
cd "$(dirname "$0")" || exit 1
if [ ! -d .venv ]; then
  echo "Setting up for the first time..."
  python3 -m venv .venv || { echo "Python 3.10+ is needed: https://www.python.org/downloads/"; exit 1; }
fi
. .venv/bin/activate
python -m pip install --quiet --disable-pip-version-check -r backend/requirements.txt || {
  echo "Installing the Python packages failed. Read the message above, then see 'If something goes wrong' in README.md."; exit 1; }
exec python run.py "$@"
