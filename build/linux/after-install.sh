#!/bin/bash
# This script REPLACES electron-builder's own postinst rather than adding to it,
# so everything that one did has to be done here too. Leaving a step out is not
# cosmetic: without the chrome-sandbox line Electron refuses to start at all,
# with "The SUID sandbox helper binary … is not configured correctly".
#
# Kept deliberately in step with node_modules/app-builder-lib/templates/linux/
# after-install.tpl — if electron-builder is upgraded, compare the two again.
set -e

# 1. Put the binary on PATH, the way the default script does.
if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/gitbraid' -a -e '/usr/bin/gitbraid' -a "`readlink '/usr/bin/gitbraid'`" != '/etc/alternatives/gitbraid' ]; then
        rm -f '/usr/bin/gitbraid'
    fi
    update-alternatives --install '/usr/bin/gitbraid' 'gitbraid' '/opt/GitBraid/gitbraid' 100 || ln -sf '/opt/GitBraid/gitbraid' '/usr/bin/gitbraid'
else
    ln -sf '/opt/GitBraid/gitbraid' '/usr/bin/gitbraid'
fi

# 2. The SUID sandbox helper. Needed whenever the kernel will not grant this
#    binary an unprivileged user namespace — the default on Ubuntu, where
#    AppArmor denies userns_create to unconfined executables.
chmod 4755 '/opt/GitBraid/chrome-sandbox' || true

# 3. AppStream metadata. electron-builder cannot place files outside /opt from
#    its config, so it rides along inside the app and is copied here; without it
#    GNOME Software has nothing to list and the app is invisible in "Installed".
SRC=/opt/GitBraid/resources/io.github.heri_anggara.GitBraid.metainfo.xml
DEST=/usr/share/metainfo/io.github.heri_anggara.GitBraid.metainfo.xml
if [ -f "$SRC" ]; then
  mkdir -p /usr/share/metainfo
  cp -f "$SRC" "$DEST"
fi

# 4. Let the desktop notice straight away rather than at the next login.
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
command -v appstreamcli >/dev/null 2>&1 && appstreamcli refresh-cache --force >/dev/null 2>&1 || true
exit 0
