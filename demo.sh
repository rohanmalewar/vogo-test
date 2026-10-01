#!/usr/bin/env bash
# Start the server (node webhooks.js) in another terminal, then run this.
URL=${URL:-http://localhost:3000}

send() {
  echo "-> $2 @ $3"
  curl -s -X POST "$URL/webhooks/bookings" -H 'content-type: application/json' \
    -d "{\"booking_id\":\"$1\",\"property_id\":\"prop_88\",\"status\":\"$2\",\"sent_at\":\"$3\"}"
  echo
}

send bk_1042 pending   2026-08-03T14:00:00Z
send bk_1042 cancelled 2026-08-03T14:30:00Z   # arrives before the confirmed it supersedes
send bk_1042 confirmed 2026-08-03T14:22:05Z   # late: stale
send bk_1042 confirmed 2026-08-03T14:22:05Z   # retry of the same: duplicate
send bk_1042 cancelled 2026-08-03T14:30:00Z   # retry: duplicate

echo; echo "final state:"
curl -s "$URL/bookings/bk_1042"; echo
