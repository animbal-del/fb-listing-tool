#!/usr/bin/env bash
set -e

export DISPLAY=:99

pkill -f "Xvfb :99" || true
pkill -f "x11vnc.*5901" || true
pkill -f "websockify.*6080" || true
pkill -f "novnc_proxy.*6080" || true
pkill -f "fluxbox" || true

rm -f /tmp/.X99-lock || true

Xvfb :99 -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!

for i in $(seq 1 40); do
  if [ -S /tmp/.X11-unix/X99 ]; then
    break
  fi

  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Xvfb failed to start; see /tmp/xvfb.log" >&2
    exit 1
  fi

  sleep 0.25
done

if [ ! -S /tmp/.X11-unix/X99 ]; then
  echo "Xvfb display :99 did not become ready; see /tmp/xvfb.log" >&2
  exit 1
fi

fluxbox >/tmp/fluxbox.log 2>&1 &
sleep 1

x11vnc -display :99 -forever -shared -nopw -noxdamage -repeat -rfbport 5901 >/tmp/x11vnc.log 2>&1 &
sleep 1

/usr/share/novnc/utils/novnc_proxy --vnc localhost:5901 --listen 6080 >/tmp/novnc.log 2>&1 &
sleep 2

echo "Remote desktop ready on port 6080"
