#!/bin/sh
# Fill the store templates with your own details, then delete the templates.
#   ./build/linux/fill.sh <github-username> <email> [donation-url]
set -e
[ $# -ge 2 ] || { echo "usage: $0 <github-username> <email> [donation-url]" >&2; exit 1; }
USER=$1; MAIL=$2; DONATE=${3:-}
# A GitHub username may contain hyphens; an AppStream component ID may not.
# Flathub's own convention is to swap them for underscores in the ID only —
# the URLs still use the real username.
IDUSER=$(printf '%s' "$USER" | tr '-' '_')
APPID="io.github.$IDUSER.GitBraid"
HOME_URL="https://github.com/$USER/gitbraid"
RAW="https://raw.githubusercontent.com/$USER/gitbraid/main"
DIR=$(dirname "$0")

for ext in metainfo.xml desktop; do
  out="$DIR/$APPID.$ext"
  sed -e "s|APPID|$APPID|g" \
      -e "s|DEVELOPER_ID|io.github.$IDUSER|g" \
      -e "s|HOMEPAGE_RAW|$RAW|g" \
      -e "s|HOMEPAGE|$HOME_URL|g" \
      "$DIR/APPID.$ext" > "$out"
  if [ -n "$DONATE" ]; then
    sed -i -e "s|DONATION|$DONATE|" "$out"
  else
    # No donation page yet: drop the line rather than ship a dead link.
    sed -i -e '/type="donation"/d' -e '/Remove this line until/d' "$out"
  fi
  echo "wrote $out"
done
rm -f "$DIR/APPID.metainfo.xml" "$DIR/APPID.desktop"
echo "App ID is $APPID — put the same value in package.json build.appId"
