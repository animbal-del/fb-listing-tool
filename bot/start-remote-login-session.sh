#!/usr/bin/env bash
set -e

export DISPLAY=:99

pkill -f "Xvfb :99" || true
pkill -f "x11vnc.*5901" || true
pkill -f "websockify.*6080" || true
pkill -f "fluxbox" || true

rm -f /tmp/.X99-lock || true

Xvfb :99 -screen 0 1440x900x24 &
sleep 2

fluxbox >/tmp/fluxbox.log 2>&1 &
sleep 1

x11vnc -display :99 -forever -shared -nopw -rfbport 5901 >/tmp/x11vnc.log 2>&1 &
sleep 1

/usr/share/novnc/utils/novnc_proxy --vnc localhost:5901 --listen 6080 >/tmp/novnc.log 2>&1 &
sleep 2

echo "Remote desktop ready on port 6080"