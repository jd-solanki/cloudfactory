#!/usr/bin/env bash
# Turn on Code Factory reviews for one or more repositories.
#
# Creates the agent:review label, sets the two Cloudflare secrets, and commits
# the workflow file that starts a Run. Safe to run again on the same repository.
set -euo pipefail

# The request label plus every state a Run projects. Creating them up front
# means a Run never depends on a label being made for it mid-flight.
# Fields are pipe separated because the label names contain colons.
readonly LABELS="agent:review|5319E7|Ask the Code Factory to review this pull request
agent:reviewing|FBCA04|A Run is reviewing this pull request
agent:failed|B60205|A Run failed. Apply agent:review to try again"
readonly REQUEST_LABEL="agent:review"
readonly WORKFLOW_PATH=".github/workflows/agent-review.yml"
readonly DEFAULT_REF="jd-solanki/cloudfactory@main"

usage() {
  cat <<USAGE
Usage: scripts/enable-repo.sh --token TOKEN --account ID ORG/REPO [ORG/REPO...]

Creates the agent:review, agent:reviewing and agent:failed labels, sets the
two Cloudflare secrets, and commits the workflow file.

Options:
  --token TOKEN    Cloudflare API token with account-scoped Workers Scripts: Write
  --account ID     Cloudflare account that hosts your review Worker
  --ref REF        Reusable workflow to call (default: ${DEFAULT_REF})
  -h, --help       Show this message

Example:
  scripts/enable-repo.sh --token cf_xxx --account 1a2b3c john/dotfiles octocorp/app

A token passed on the command line is visible to other processes on this
machine and lands in your shell history. Use a throwaway token, or prefix the
command with a space where your shell is set to skip those.
USAGE
}

# Every bad invocation ends the same way: say what is wrong, then show usage.
die() {
  echo "error: $1" >&2
  usage >&2
  exit 2
}

token=""
account=""
ref="$DEFAULT_REF"
repos=()

need_value() {
  [ -n "${2:-}" ] || die "$1 needs a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token)
      need_value "$1" "${2:-}"
      token="$2"
      shift 2
      ;;
    --account)
      need_value "$1" "${2:-}"
      account="$2"
      shift 2
      ;;
    --ref)
      need_value "$1" "${2:-}"
      ref="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option $1" ;;
    *)
      repos+=("$1")
      shift
      ;;
  esac
done

[ -n "$token" ] || die "--token is required"
[ -n "$account" ] || die "--account is required"
[ ${#repos[@]} -gt 0 ] || die "name at least one ORG/REPO"

for tool in gh base64; do
  command -v "$tool" >/dev/null || {
    echo "error: $tool is not installed" >&2
    exit 1
  }
done

upstream="${ref%@*}"
version="${ref##*@}"

workflow_body() {
  cat <<YAML
# Managed by scripts/enable-repo.sh in ${upstream}.
name: Code Factory review

on:
  pull_request_target:
    types: [labeled]

jobs:
  review:
    uses: ${upstream}/.github/workflows/review.yml@${version}
    secrets: inherit
YAML
}

enable() {
  local repo="$1"

  case "$repo" in
    */*) ;;
    *) die "'${repo}' is not ORG/REPO" ;;
  esac

  echo "==> ${repo}"

  # gh label create fails when the label is already there, which is fine.
  while IFS="|" read -r name color description; do
    [ -n "$name" ] || continue
    if gh label create "$name" --repo "$repo" --color "$color" \
      --description "$description" >/dev/null 2>&1; then
      echo "    label ${name} created"
    else
      echo "    label ${name} already present"
    fi
  done <<<"$LABELS"

  gh secret set CLOUDFLARE_API_TOKEN --repo "$repo" --body "$token"
  gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$repo" --body "$account"
  echo "    secrets set"

  # Updating a file through the contents API needs the blob it replaces.
  local sha
  sha=$(gh api "repos/${repo}/contents/${WORKFLOW_PATH}" --jq .sha 2>/dev/null || true)

  local content
  content=$(workflow_body | base64 | tr -d '\n')

  local args=(
    --method PUT
    "repos/${repo}/contents/${WORKFLOW_PATH}"
    -f "message=ci: enable Code Factory reviews"
    -f "content=${content}"
  )
  if [ -n "$sha" ]; then
    args+=(-f "sha=${sha}")
  fi

  if gh api "${args[@]}" >/dev/null; then
    echo "    workflow committed"
  else
    echo "    workflow unchanged"
  fi

  echo "    done. Apply the ${REQUEST_LABEL} label to a pull request."
}

for repo in "${repos[@]}"; do
  enable "$repo"
done
