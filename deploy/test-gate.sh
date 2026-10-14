#!/usr/bin/env bash
# Exercise the real deployment script with isolated fake external commands.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$(mktemp -d "$SCRIPT_DIR/.gate-fixture.XXXXXX")"
case "$FIXTURE" in "$SCRIPT_DIR"/.gate-fixture.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin" "$FIXTURE/app/deploy"
export MARKER="$FIXTURE/actions"
cat > "$FIXTURE/bin/npm" <<'MOCK'
#!/usr/bin/env bash
if [ "$1" = test ]; then
  printf '%s\n' "${TEST_OUTPUT-# fail 0}"
  exit "${TEST_EXIT:-0}"
fi
exit 0
MOCK
cat > "$FIXTURE/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MARKER"
exit 0
MOCK
for cmd in ss git curl systemctl sleep; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/bin/$cmd"
done
chmod +x "$FIXTURE/bin/"*
export PATH="$FIXTURE/bin:$PATH" APP_DIR="$FIXTURE/app" SKIP_GIT=1

run_case() {
  local name="$1" code="$2" output="$3" expected="$4" actual=0
  : > "$MARKER"
  TEST_EXIT="$code" TEST_OUTPUT="$output" bash "$SCRIPT_DIR/deploy.sh" > "$FIXTURE/output" 2>&1 || actual=$?
  if [ "$expected" = stop ]; then
    if [ "$actual" -eq 0 ] || grep -q 'systemctl restart' "$MARKER"; then
      echo "FAIL: $name: exit=$actual; failing test reached deployment"
      cat "$FIXTURE/output"
      exit 1
    fi
  else
    if [ "$actual" -ne 0 ] || ! grep -q 'systemctl restart hearthstone-lite' "$MARKER"; then
      echo "FAIL: $name: exit=$actual; passing test did not deploy"
      cat "$FIXTURE/output"
      exit 1
    fi
  fi
  echo "PASS: $name"
}
run_case 'failure with misleading success text' 37 '# fail 0' stop
run_case 'failure with normal TAP text' 1 '# fail 1' stop
run_case 'TAP success' 0 '# fail 0' proceed
run_case 'spec success' 0 'ℹ fail 0' proceed
run_case 'silent success' 0 '' proceed
