FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends socat gnutls-bin openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY openssl.cnf /etc/legacy/openssl.cnf
COPY entrypoint.sh /etc/legacy/entrypoint.sh
ENV OPENSSL_CONF=/etc/legacy/openssl.cnf
ENTRYPOINT ["/bin/sh", "/etc/legacy/entrypoint.sh"]
