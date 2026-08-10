#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook: refuse `git push` until the local CI gates pass.
#
# Reads the hook payload on stdin. Non-push commands exit immediately, so the
# overhead on ordinary Bash calls is one short script invocation.
#
# On failure it emits a PreToolUse deny decision, which blocks the push and hands
# the reason back to the model so it can fix the problem instead of retrying.

set -uo pipefail

PAYLOAD="$(cat)"
CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // ""' 2>/dev/null)"

# Only gate actual pushes (covers `git push`, `git -C <dir> push`, flags, etc.).
# Deliberately ignores --dry-run.
if ! printf '%s' "$CMD" | grep -Eq '(^|[;&|]|\s)git(\s+-[^;&|]*)?\s+push(\s|$)'; then
  exit 0
fi
if printf '%s' "$CMD" | grep -q -- '--dry-run'; then
  exit 0
fi

REPO="/Users/rteslow/mikrotik-manager"
[[ -x "$REPO/scripts/ci-preflight.sh" ]] || exit 0   # nothing to enforce

if OUTPUT="$("$REPO/scripts/ci-preflight.sh" 2>&1)"; then
  exit 0
fi

DETAIL="$(tail -60 /tmp/ci-preflight-failures 2>/dev/null)"
python3 - "$OUTPUT" "$DETAIL" <<'PY'
import json, sys
summary, detail = sys.argv[1], sys.argv[2]
reason = (
    "Push blocked: the local CI gates failed, so this would fail on GitHub too.\n\n"
    f"{summary.strip()}\n\n{detail.strip()}\n\n"
    "Fix these, re-run scripts/ci-preflight.sh until it passes, then push."
)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }
}))
PY
exit 0
