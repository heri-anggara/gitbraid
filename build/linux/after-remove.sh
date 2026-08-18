#!/bin/bash
# Also a replacement for electron-builder's own postrm, so it has to take the
# /usr/bin link away as well as the metadata.
set -e

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'gitbraid' '/opt/GitBraid/gitbraid' || true
else
    rm -f '/usr/bin/gitbraid'
fi

rm -f /usr/share/metainfo/io.github.heri_anggara.GitBraid.metainfo.xml
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v appstreamcli >/dev/null 2>&1 && appstreamcli refresh-cache --force >/dev/null 2>&1 || true
exit 0
