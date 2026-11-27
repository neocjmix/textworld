ARG TARGETARCH
FROM node:24-alpine AS plugin-amd64
ADD --checksum=sha256:e637e1d8e4a5245e4d0ae6a9f5ff26e3aeedb9a0fad994ea43fe24bfb3f3ffcb https://grafana.com/api/plugins/yesoreyeram-infinity-datasource/versions/4.1.8/download?os=linux&arch=amd64 /tmp/infinity.zip
FROM node:24-alpine AS plugin-arm64
ADD --checksum=sha256:0b366b0051264a2558da5173123acb53775884ea8a81c45e2db92eb149fc3655 https://grafana.com/api/plugins/yesoreyeram-infinity-datasource/versions/4.1.8/download?os=linux&arch=arm64 /tmp/infinity.zip

FROM plugin-${TARGETARCH} AS release
WORKDIR /build
COPY dashboard.mjs datasource.yaml provider.yaml start.sh ./
RUN mkdir -p /release/dashboards /release/plugins /release/provisioning/datasources /release/provisioning/dashboards \
        /release/provisioning/alerting /release/provisioning/plugins /release/provisioning/access-control && \
    node dashboard.mjs > /release/dashboards/overview.json && chmod 644 /release/dashboards/overview.json && \
    install -m 644 datasource.yaml /release/provisioning/datasources/textworld.yaml && \
    install -m 644 provider.yaml /release/provisioning/dashboards/textworld.yaml && \
    install -m 755 start.sh /release/start.sh && \
    unzip -q /tmp/infinity.zip -d /release/plugins && \
    find /release -type d -exec chmod 755 '{}' +

FROM grafana/grafana:13.3.2
USER root
ENV GF_PATHS_PROVISIONING=/opt/textworld/provisioning \
    GF_PATHS_PLUGINS=/opt/textworld/plugins \
    GF_PLUGINS_PREINSTALL_DISABLED=true \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/opt/textworld/dashboards/overview.json \
    GF_DASHBOARDS_MIN_REFRESH_INTERVAL=1m \
    GF_USERS_DEFAULT_LANGUAGE=ko-KR \
    GF_AUTH_ANONYMOUS_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_PUBLIC_DASHBOARDS_ENABLED=false \
    GF_SNAPSHOTS_ENABLED=false \
    GF_SECURITY_COOKIE_SECURE=true \
    GF_ANALYTICS_REPORTING_ENABLED=false
COPY --from=release /release/ /opt/textworld/
ENTRYPOINT ["/opt/textworld/start.sh"]
