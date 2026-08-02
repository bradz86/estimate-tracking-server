SCR="${TMPDIR:-/tmp}/estimatepro-account-test"; mkdir -p "$SCR"
PORT=4131
rm -f "$SCR/tdb4.json"
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 1
API_KEY=testkey PORT=$PORT DB_PATH="$SCR/tdb4.json" node server.js > "$SCR/s4.out" 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s -m 2 -o /dev/null "http://localhost:$PORT/health" && break; sleep 0.5; done

A=aaaaaaaa-1111-2222-3333-444444444444
B=bbbbbbbb-1111-2222-3333-444444444444
H="Authorization: Bearer testkey"; J="Content-Type: application/json"
U="http://localhost:$PORT"; C="curl -s -m 10"
pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (want '$2' got '$3')"; fail=$((fail+1)); fi; }

$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{"title":"Kitchen","customerName":"Jane","total":"1200"}' "$U/api/register/TA" >/dev/null
$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" -d '{"title":"Roof","customerName":"Bob","total":"800"}' "$U/api/register/TB" >/dev/null
$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{"email":"a@x.com"}' "$U/api/contractor/register" >/dev/null
$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{"deviceToken":"tokA"}' "$U/api/device/register" >/dev/null
$C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" -d '{"deviceToken":"tokB"}' "$U/api/device/register" >/dev/null
$C -o /dev/null "$U/view/TA"; $C -o /dev/null "$U/view/TB"

check "apple/link reports 501 when unconfigured" "501" \
  "$($C -o /dev/null -w '%{http_code}' -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{"authorizationCode":"c"}' "$U/api/apple/link")"
check "apple/revoke reports 501 when unconfigured" "501" \
  "$($C -o /dev/null -w '%{http_code}' -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{}' "$U/api/apple/revoke")"
check "account/delete succeeds" "200" \
  "$($C -o /dev/null -w '%{http_code}' -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{}' "$U/api/account/delete")"

A_EST=$($C -H "$H" -H "X-Contractor-Id: $A" "$U/api/estimates")
check "A's estimates erased" '{"estimates":[]}' "$A_EST"
A_NOT=$($C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $A" -d '{}' "$U/api/notifications")
check "A's notifications erased" "[]" "$A_NOT"

B_EST=$($C -H "$H" -H "X-Contractor-Id: $B" "$U/api/estimates")
case "$B_EST" in *"Roof"*) echo "  PASS  B's data survived A's deletion"; pass=$((pass+1));;
  *) echo "  FAIL  B's data was destroyed (got $B_EST)"; fail=$((fail+1));; esac
B_NOT=$($C -X POST -H "$H" -H "$J" -H "X-Contractor-Id: $B" -d '{}' "$U/api/notifications")
case "$B_NOT" in *"Bob"*) echo "  PASS  B's notifications survived"; pass=$((pass+1));;
  *) echo "  FAIL  B's notifications destroyed"; fail=$((fail+1));; esac
grep -q '"token": "tokB"' "$SCR/tdb4.json" && { echo "  PASS  B's device token survived"; pass=$((pass+1)); } || { echo "  FAIL  B's device token gone"; fail=$((fail+1)); }
grep -q '"token": "tokA"' "$SCR/tdb4.json" && { echo "  FAIL  A's device token still present"; fail=$((fail+1)); } || { echo "  PASS  A's device token removed"; pass=$((pass+1)); }

kill $SRV 2>/dev/null
echo; echo "  $pass passed, $fail failed"
