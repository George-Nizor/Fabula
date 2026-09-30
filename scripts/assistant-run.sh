#!/usr/bin/env bash
# Run by the assistant pane inside a login shell (`bash -l`), so nvm and the
# user's CLI paths load, with the window's choice as plain arguments. Stays
# on screen after a failure so a missing CLI or login problem can be read.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 1
# An installed engine keeps its Node in bin/ (scripts/setup-engine.sh); a checkout has none.
if [ -d bin ]; then export PATH="$PWD/bin:$PATH"; fi
node scripts/assistant.mjs "$@"
status=$?
if [ "$status" -ne 0 ]; then
  printf '\nThe assistant exited with code %s. Close this pane, or start another session.\n' "$status"
fi
exit "$status"
