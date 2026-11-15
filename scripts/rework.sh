#!/usr/bin/env bash
# Métricas de retrabalho do experimento pipeline × direto (docs/experiment/PROTOCOL.md).
#   scripts/rework.sh             tabela de todas as features com os dois braços aceitos
#   scripts/rework.sh blind F01   exporta A.diff/B.diff embaralhados para revisão cega
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
EXCL=(':!*lock.yaml' ':!.pipeline' ':!docs/experiment' ':!*test/oracle/*')

# soma de linhas de um diff: "add" = só adições, "all" = adições + remoções
lines() { git diff --numstat "$1" "$2" -- . "${EXCL[@]}" | awk -v m="$3" '{a+=$1; d+=$2} END {print (m=="add") ? a+0 : a+d+0}'; }
has() { git rev-parse -q --verify "refs/tags/$1" >/dev/null; }

if [[ ${1:-} == blind ]]; then
  f=$2 out=$(mktemp -d) arms=(direct pipeline)
  (( RANDOM % 2 )) && arms=(pipeline direct)
  git diff "$f-base" "$f-${arms[0]}-done" -- . "${EXCL[@]}" > "$out/A.diff"
  git diff "$f-base" "$f-${arms[1]}-done" -- . "${EXCL[@]}" > "$out/B.diff"
  echo "A=${arms[0]} B=${arms[1]}" > "$out/.key"
  echo "$out  (registre a revisão no ledger antes de abrir .key)"
  exit
fi

for base in $(git tag -l 'F*-base' | sort); do
  f=${base%-base}
  has "$f-direct-accepted" && has "$f-pipeline-accepted" || continue # só pares completos
  for arm in direct pipeline; do
    printf '%s\t%s\t%s\t%s\t%s\n' "$f" "$arm" \
      "$(lines "$base" "$f-$arm-done" add)" \
      "$(lines "$f-$arm-done" "$f-$arm-accepted" all)" \
      "$(git rev-list --count "$f-$arm-done..$f-$arm-accepted")"
  done
done | awk -F'\t' '
  BEGIN { print "| feature | braço | entregue (+) | retrabalho (±) | rodadas | retrabalho/entregue |"
          print "|---|---|---:|---:|---:|---:|" }
  { printf "| %s | %s | %d | %d | %d | %.0f%% |\n", $1, $2, $3, $4, $5, ($3 ? 100*$4/$3 : 0)
    del[$2]+=$3; rw[$2]+=$4; rd[$2]+=$5 }
  END {
    for (a in del) printf "| **total** | %s | %d | %d | %d | %.0f%% |\n", a, del[a], rw[a], rd[a], (del[a] ? 100*rw[a]/del[a] : 0)
    if (rw["direct"] > 0) printf "\nRedução de retrabalho (linhas): %.0f%%\n", 100 * (1 - rw["pipeline"] / rw["direct"])
    if (rd["direct"] > 0) printf "Redução de rodadas de correção: %.0f%%\n", 100 * (1 - rd["pipeline"] / rd["direct"])
  }'
