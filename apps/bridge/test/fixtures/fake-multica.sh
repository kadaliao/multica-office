#!/bin/sh
if [ "$1 $2 $3 $4" = "agent list --output json" ]; then
	printf '[{"id":"11111111-1111-4111-8111-111111111111","name":"Agent","runtime_id":"22222222-2222-4222-8222-222222222222","status":"idle","updated_at":"2026-01-01T00:00:00Z","instructions":"secret"}]'
elif [ "$1 $2 $3 $4" = "runtime list --output json" ]; then
	printf '[]'
elif [ "$1 $2 $3" = "issue list --limit" ] && [ "$4" = "100" ] && [ "$5" = "--offset" ] && [ "$7 $8" = "--output json" ]; then
	printf '{"issues":[],"has_more":false,"offset":%s,"limit":100}' "$6"
elif [ "$1 $2" = "issue runs" ] && [ "$4 $5" = "--output json" ]; then
	printf '[]'
else
	printf 'unexpected argv' >&2
	exit 9
fi
