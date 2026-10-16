FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xrdp xorgxrdp ssl-cert dbus dbus-x11 procps \
      xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal xfconf \
 && rm -rf /var/lib/apt/lists/* \
 && adduser xrdp ssl-cert

COPY startwm.sh /etc/xrdp/startwm.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /etc/xrdp/startwm.sh /entrypoint.sh

EXPOSE 3389
CMD ["/entrypoint.sh"]
