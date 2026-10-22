#!/usr/bin/env bash
# Renews the scribe.upliftedconsulting.com certificate (Let's Encrypt via Cloudflare DNS) when due,
# then restarts the server to load it. Runs daily from cron.
set -euo pipefail
set -a; source "$HOME/.config/uplifted-content/cf.env"; set +a
export CF_DNS_API_TOKEN="$CLOUDFLARE_API_TOKEN"
"$HOME/.local/bin/lego" run --accept-tos --email riccardo@upliftedconsulting.com \
  --dns cloudflare --dns.resolvers 1.1.1.1:53 --domains scribe.upliftedconsulting.com \
  --path "$HOME/.local/share/lego" --log.format text \
  --deploy-hook "docker restart send-to-scribe"
