#!/bin/bash
# Proves tenant isolation on the tracking server.
SCR="${TMPDIR:-/tmp}/estimatepro-isolation-test"; mkdir -p "$SCR"
SRVDIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4123
rm -f "$SCR/tdb.json"
cd "$SRVDIR" || exit 1
API_KEY=testkey PORT=$PORT DB_PATH="$SCR/tdb.json" node server.js > "$SCR/s.out" 2>&1 &
SRV=$!
# No EXIT trap here: bash fires EXIT traps in command-substitution subshells too,
# which would kill the server on the first $(...) below.

for i in $(seq 1 40); do
  curl -s -m 2 -o /dev/null "http://localhost:$PORT/health" && break
  sleep 0.5
done

A=aaaaaaaa-1111-2222-3333-444444444444
B=bbbbbbbb-1111-2222-3333-444444444444
H="Authorization: Bearer testkey"
J="Content-Type: application/json"
U="http://localhost:$PORT"
C="curl -s -m 10"

pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi
}
nocontain() { # name needle haystack
  case "$3" in
    *"$2"*) echo "  FAIL  $1 (leaked '$2')"; fail=$((fail+1));;
    *) echo "  PASS  $1"; pass=$((pass+1));;
  esac
}

$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" \
  -d '{"title":"Kitchen Remodel","customerName":"Jane Smith","customerEmail":"jane@x.com","total":"12400"}' \
  "$U/api/register/TRACK_A" > /dev/null
$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" \
  -d '{"title":"Roof Repair","customerName":"Bob Jones","total":"8000"}' \
  "$U/api/register/TRACK_B" > /dev/null

# A customer opens A's estimate link
$C -o /dev/null "$U/view/TRACK_A"

B_EST=$($C -H "$H" -H "X-Contractor-Id: $B" "$U/api/estimates")
nocontain "B's estimate list omits A's customer" "Jane Smith" "$B_EST"
nocontain "B's estimate list omits A's title"    "Kitchen Remodel" "$B_EST"

B_NOTIF=$($C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" -d '{}' "$U/api/notifications")
check "B receives no notification for A's view" "[]" "$B_NOTIF"

A_NOTIF=$($C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{}' "$U/api/notifications")
case "$A_NOTIF" in
  *"Jane Smith"*) echo "  PASS  A does receive own notification"; pass=$((pass+1));;
  *) echo "  FAIL  A missing own notification (got $A_NOTIF)"; fail=$((fail+1));;
esac

check "B cannot read A's view stats" "404" \
  "$($C -o /dev/null -w '%{http_code}' -H "$H" -H "X-Contractor-Id: $B" "$U/api/views/TRACK_A")"
check "A can read own view stats" "200" \
  "$($C -o /dev/null -w '%{http_code}' -H "$H" -H "X-Contractor-Id: $A" "$U/api/views/TRACK_A")"
check "missing contractor id rejected" "400" \
  "$($C -o /dev/null -w '%{http_code}' -H "$H" "$U/api/estimates")"
check "reserved legacy id rejected" "400" \
  "$($C -o /dev/null -w '%{http_code}' -H "$H" -H "X-Contractor-Id: __legacy__" "$U/api/estimates")"
check "B cannot hijack A's tracking id" "409" \
  "$($C -o /dev/null -w '%{http_code}' -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" -d '{"title":"stolen"}' "$U/api/register/TRACK_A")"
check "wrong api key rejected" "403" \
  "$($C -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" -H "X-Contractor-Id: $A" "$U/api/estimates")"
check "app POST to /api/notifications works" "200" \
  "$($C -o /dev/null -w '%{http_code}' -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{"deviceToken":"tok"}' "$U/api/notifications")"

# read-all must not touch the other tenant
$C -o /dev/null -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" -d '{}' "$U/api/notifications/read-all"
A_AFTER=$($C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{}' "$U/api/notifications")
case "$A_AFTER" in
  *'"isRead":false'*) echo "  PASS  B's read-all left A's notification unread"; pass=$((pass+1));;
  *) echo "  FAIL  B's read-all modified A's notification"; fail=$((fail+1));;
esac

kill $SRV 2>/dev/null

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
