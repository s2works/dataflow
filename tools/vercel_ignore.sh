#!/bin/bash
# Vercel "Ignored Build Step" for the dataflow project (Project Settings → Git;
# runs from web/, the project's root directory). Exit 0 = skip this
# deployment, exit 1 = deploy.
#
# The data refresh commits hourly and every deployment keeps a full copy of
# the site in Vercel's deployment storage, so data-only commits deploy at most
# every MIN_HOURS. Code/page changes and newly pulled Vegas prop lines always
# deploy. Skipped commits ride along with the next deployment.

MIN_HOURS=${MIN_HOURS:-3}
PREV="$VERCEL_GIT_PREVIOUS_SHA"   # last successfully deployed commit

[ -z "$PREV" ] && { echo "No previous deployment: deploy"; exit 1; }
git cat-file -e "$PREV^{commit}" 2>/dev/null || git fetch -q --depth=200 origin "$VERCEL_GIT_COMMIT_REF" 2>/dev/null
git cat-file -e "$PREV^{commit}" 2>/dev/null || { echo "Previous commit not available: deploy"; exit 1; }

CHANGED=$(git diff --name-only "$PREV" HEAD)
if echo "$CHANGED" | grep -q -v -e '^web/data/' -e '^$'; then
  echo "Code or page changes: deploy"; exit 1
fi
if echo "$CHANGED" | grep -q '^web/data/nfl/props_'; then
  echo "New Vegas prop lines: deploy"; exit 1
fi
AGE=$(( $(git log -1 --format=%ct HEAD) - $(git log -1 --format=%ct "$PREV") ))
if [ "$AGE" -ge $(( MIN_HOURS * 3600 )) ]; then
  echo "Data ${AGE}s newer than the live site: deploy"; exit 1
fi
echo "Data-only change ${AGE}s after the last deployment: skip (next deploy includes it)"
exit 0
