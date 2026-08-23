#!/bin/sh
# popcorn full monty — published at https://dl.bullmoose.cc/popcorn/fullmonty.sh
#
#   curl -fsSL https://dl.bullmoose.cc/popcorn/fullmonty.sh | sh
#
# The no-questions install, for automation and for operators who have read
# install.sh once and do not need to be asked again: choosing THIS url over
# install.sh is the consent its prompt would have collected. Same download,
# same checksum verification, same planner, same refusal gates — the planner
# still refuses a plan that widens a listen address or drops TLS, and no
# amount of monty overrides that (that is --allow-widen/--allow-plaintext,
# which you must type yourself).
set -eu
BASE=${POPCORN_DL_BASE:-https://dl.bullmoose.cc/popcorn}
curl -fsSL "$BASE/install.sh" | sh -s -- --full-monty "$@"
