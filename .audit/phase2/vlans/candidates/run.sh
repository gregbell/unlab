#!/usr/bin/env bash
# Every rule that was tried for what one broadcast costs at once, through the same three scripts.
#
#   bash .audit/phase2/vlans/candidates/run.sh [dir]     from the repository's root; dir is made, default a new temp dir
#
# It takes the fabric of 0cdf8d5, which has no such rule, and gives it each candidate with fabric.patch, chosen by
# RULE and HOPS. For each it prints fanout.mjs, fuzz.mjs on the verifier's wirings and on dense ones, and probe.mjs.
#
#   c0   as 0cdf8d5: a frame goes at once until it comes back to a switch in a VLAN it was in there
#   c1   a frame that comes back to a switch in any VLAN waits its turn when a switch floods it
#   c2   a frame that has crossed HOPS cables waits its turn when a switch floods it
#   c3a  a copy that comes into a switch in a VLAN after another copy of the frame waits its turn
#   c3b  as c3a, and a frame has looped only when it comes back by the port it came in by before
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$(mktemp -d)}
mkdir -p "$dir"
git archive 0cdf8d5 src | tar -x -C "$dir"
git apply --directory="$dir" --unsafe-paths "$here/fabric.patch" 2>/dev/null || (cd "$dir" && git apply "$here/fabric.patch")
fabric=$dir/src/runtime/fabric.ts
# One at a time, so that each one's milliseconds are its own.
for spec in "c0 8" "c1 8" "c2 8" "c2 4" "c2 2" "c3a 8" "c3b 8"; do
	set -- $spec
	label=$1
	[ "$1" = c2 ] && label="c2 after $2 cables"
	(
		export RULE=$1 HOPS=$2
		{
			echo "== $label"
			node "$here/../fanout.mjs" "$fabric" 300 1
			echo "-- fuzz.mjs 3000 1"
			node "$here/../fuzz.mjs" "$fabric" 3000 1 | head -1
			echo "-- fuzz.mjs 1000 1 dense"
			node "$here/../fuzz.mjs" "$fabric" 1000 1 dense | head -1
			echo "-- probe.mjs"
			node "$here/probe.mjs" "$fabric"
		} 2>&1
	)
done
