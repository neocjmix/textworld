#!/bin/sh
set -eu
: "${GF_SECURITY_ADMIN_PASSWORD:?Set a Grafana administrator password}"
: "${GF_SECURITY_SECRET_KEY:?Set a stable encryption key}"
: "${TEXTWORLD_METRICS_ORIGIN:?Set the internal Textworld origin}"
: "${TEXTWORLD_METRICS_TOKEN:?Set the read-only Textworld metrics token}"
# A newly attached Railway volume can be owned by root. Limit the ownership
# change to the mount point, then run Grafana as the image's regular user.
if [ "$(id -u)" = 0 ]; then
  chown grafana:root "$GF_PATHS_DATA"
  exec su -p -s /bin/sh grafana -c 'exec /run.sh "$@"' grafana "$@"
fi
exec /run.sh "$@"
