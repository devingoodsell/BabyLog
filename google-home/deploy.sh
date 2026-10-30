#!/usr/bin/env bash
# Deploys the Baby Log Google Home service to Cloud Run in your current Google Cloud project.
# Run it in Google Cloud Shell:
#   git clone https://github.com/devingoodsell/BabyLog && cd BabyLog/google-home && ./deploy.sh
#
# Safe to run again: it reuses the secrets saved in ~/.babylog-home.env, so an existing
# Google Home link keeps working after a redeploy.
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=babylog-home
REGION="${REGION:-us-east1}"
SECRETS="$HOME/.babylog-home.env"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$PROJECT" ] || fail "No Google Cloud project selected. Run: gcloud config set project YOUR_PROJECT_ID"
bold "Project: $PROJECT   Region: $REGION"

API="$(sed -n "s/.*apiUrl: *'\([^']*\)'.*/\1/p" ../config.js)"
[ -n "$API" ] || fail "config.js has no apiUrl. Set up the Baby Log sheet and app first (see README)."

rand_hex() { python3 -c 'import secrets,sys; print(secrets.token_hex(int(sys.argv[1])))' "$1"; }
rand_code() { python3 -c 'import secrets; a="ABCDEFGHJKMNPQRSTVWXYZ23456789"; c="".join(secrets.choice(a) for _ in range(8)); print(c[:4]+"-"+c[4:])'; }

get_key() {
  echo "In the Baby Log app: tap your initial > Invite someone > name it \"Google Home\" > Create invite link."
  echo "Then copy the link and paste it here. It is used once, right now, to give this service its own key."
  read -r -p "Invite link: " LINK
  CODE="${LINK##*#invite=}"
  [[ "$CODE" =~ ^[a-f0-9]{32}$ ]] || fail "That doesn't look like a Baby Log invite link."
  RESP="$(curl -sSL --max-time 60 -H 'Content-Type: text/plain' \
    --data "{\"action\":\"redeem\",\"code\":\"$CODE\",\"name\":\"Google Home\"}" "$API")"
  BABYLOG_TOKEN="$(printf '%s' "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["token"] if d.get("ok") else "")' 2>/dev/null || true)"
  [ -n "$BABYLOG_TOKEN" ] || fail "The invite could not be used: $RESP"
}
save_secrets() {
  umask 077
  cat > "$SECRETS" <<EOF
CLIENT_ID='$CLIENT_ID'
CLIENT_SECRET='$CLIENT_SECRET'
SIGNING_KEY='$SIGNING_KEY'
LINK_PASSCODE='$LINK_PASSCODE'
BABYLOG_TOKEN='$BABYLOG_TOKEN'
EOF
}

if [ -f "$SECRETS" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS"
  bold "Reusing saved settings from $SECRETS"
  if [ "${1:-}" = "--new-key" ]; then
    bold "Replacing the Baby Log key (the Google Home link is kept)"
    get_key
    save_secrets
  fi
else
  bold "First-time setup"
  get_key
  CLIENT_ID="babylog-$(rand_hex 8)"
  CLIENT_SECRET="$(rand_hex 24)"
  SIGNING_KEY="$(rand_hex 32)"
  LINK_PASSCODE="$(rand_code)"
  save_secrets
  echo "Saved settings to $SECRETS (only readable by you)."
fi

bold "Turning on the Google Cloud services this needs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet

# New projects don't give the default build account permission to build. Grant it the
# Cloud Run Builder role once (Google's documented fix), then give IAM a minute to apply.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
BUILD_SA="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
if ! gcloud projects get-iam-policy "$PROJECT" --flatten 'bindings[].members' \
     --filter "bindings.role=roles/run.builder AND bindings.members=$BUILD_SA" --format 'value(bindings.role)' | grep -q run.builder; then
  bold "Letting Cloud Build build the service (one time)"
  gcloud projects add-iam-policy-binding "$PROJECT" --member "$BUILD_SA" --role roles/run.builder --condition None --quiet >/dev/null
  echo "Waiting 60 seconds for the permission to take effect..."
  sleep 60
fi

ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
chmod 600 "$ENVFILE"
cat > "$ENVFILE" <<EOF
CLIENT_ID: '$CLIENT_ID'
CLIENT_SECRET: '$CLIENT_SECRET'
SIGNING_KEY: '$SIGNING_KEY'
LINK_PASSCODE: '$LINK_PASSCODE'
BABYLOG_API: '$API'
BABYLOG_TOKEN: '$BABYLOG_TOKEN'
EOF

bold "Building and deploying (takes 2 to 4 minutes the first time)"
gcloud run deploy "$SERVICE" --source . --region "$REGION" \
  --no-invoker-iam-check --min-instances 0 --max-instances 2 --memory 256Mi --cpu 1 \
  --env-vars-file "$ENVFILE" --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
curl -sSf --max-time 30 "$URL/" >/dev/null || fail "Deployed, but $URL/ is not answering. See Troubleshooting in the README."

bold "Done. Enter these in the Google Home Developer Console, under Account linking and Cloud fulfillment:"
cat <<EOF

  OAuth Client ID ........ $CLIENT_ID
  Client secret .......... $CLIENT_SECRET
  Authorization URL ...... $URL/oauth/authorize
  Token URL .............. $URL/oauth/token
  Cloud fulfillment URL .. $URL/fulfillment

When the Google Home app asks you to sign in to Baby Log, enter this passcode:

  Link passcode .......... $LINK_PASSCODE

EOF
