#!/bin/sh
# The launcher the desktop file runs.
#
# --ozone-platform=x11, not the softer --ozone-platform-hint. Measured: with
# `hint=auto`, `hint=x11`, or nothing at all, Electron 43 picks Wayland and dies
# with SIGSEGV before a window appears; only naming the platform outright gets
# past it. The manifest grants an X11 socket rather than a Wayland one to match.
#
# This is why the Flatpak can carry Electron 43 while the deb and the AppImage
# stay on 37: forcing the backend from a desktop launcher would mean every way
# of starting the application having to remember an argument. Here there is one
# way in, and this is the file.
# zypak-wrapper comes from org.electronjs.Electron2.BaseApp and is not optional.
# Chromium's own SUID sandbox helper needs to be owned by root with mode 4755,
# which nothing inside a Flatpak can be, and Chromium refuses to start rather
# than run unsandboxed — measured, it aborts before a window appears. Zypak
# stands in for that helper using the sandbox Flatpak already provides.
exec zypak-wrapper /app/gitbraid/electron/electron \
  --ozone-platform=x11 \
  /app/gitbraid/app "$@"
