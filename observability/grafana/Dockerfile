ARG TARGETARCH
FROM node:24-alpine AS dashboard
WORKDIR /build
COPY dashboard.mjs .
RUN node dashboard.mjs > overview.json

FROM node:24-alpine AS plugin-amd64
ADD --checksum=sha256:e637e1d8e4a5245e4d0ae6a9f5ff26e3aeedb9a0fad994ea43fe24bfb3f3ffcb https://grafana.com/api/plugins/yesoreyeram-infinity-datasource/versions/4.1.8/download?os=linux&arch=amd64 /tmp/infinity.zip
FROM node:24-alpine AS plugin-arm64
ADD --checksum=sha256:0b366b0051264a2558da5173123acb53775884ea8a81c45e2db92eb149fc3655 https://grafana.com/api/plugins/yesoreyeram-infinity-datasource/versions/4.1.8/download?os=linux&arch=arm64 /tmp/infinity.zip
FROM plugin-${TARGETARCH} AS infinity
RUN mkdir /tmp/textworld-plugins && unzip -q /tmp/infinity.zip -d /tmp/textworld-plugins

FROM grafana/grafana:13.3.2
USER root
ENV GF_PATHS_PLUGINS=/opt/grafana-plugins \
    GF_PLUGINS_PREINSTALL_DISABLED=true \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/etc/grafana/textworld/overview.json \
    GF_DASHBOARDS_MIN_REFRESH_INTERVAL=1m \
    GF_AUTH_ANONYMOUS_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_PUBLIC_DASHBOARDS_ENABLED=false \
    GF_SNAPSHOTS_ENABLED=false \
    GF_SECURITY_COOKIE_SECURE=true \
    GF_ANALYTICS_REPORTING_ENABLED=false
COPY --from=infinity --chown=472:0 /tmp/textworld-plugins /opt/grafana-plugins
COPY --from=dashboard /build/overview.json /etc/grafana/textworld/overview.json
COPY datasource.yaml /etc/grafana/provisioning/datasources/textworld.yaml
COPY provider.yaml /etc/grafana/provisioning/dashboards/textworld.yaml
COPY --chmod=755 start.sh /usr/local/bin/textworld-grafana
ENTRYPOINT ["/usr/local/bin/textworld-grafana"]
