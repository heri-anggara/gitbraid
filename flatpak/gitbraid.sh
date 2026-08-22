#!/bin/sh
# The launcher the desktop file runs.
#
# --ozone-platform-hint=auto is the whole reason this Flatpak can carry a newer
# Electron than the deb and the AppImage do. Electron 38 and up default to the
# native Wayland backend, which crashes before a window appears on an ordinary
# GNOME Wayland session; passing the hint on the command line avoids it, and a
# switch set from JavaScript does not, because the backend is chosen before the
# main script runs. On a desktop that meant every way of launching the app
# having to remember an argument. In here there is exactly one way to launch it,
# and this is the file.
exec /app/gitbraid/electron/electron \
  --ozone-platform-hint=auto \
  /app/gitbraid/app "$@"
