# Flatpak

The manifest Flathub builds from, and the launcher it installs.

```bash
sudo apt install flatpak-builder
flatpak install flathub org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08

flatpak-builder --user --install --force-clean build flatpak/io.github.heri_anggara.GitBraid.yml
flatpak run io.github.heri_anggara.GitBraid
```

`zypak-wrapper` in the launcher is not optional either. Chromium's own SUID
sandbox helper has to be owned by root with mode 4755, which nothing inside a
Flatpak can be, and Chromium aborts rather than run unsandboxed. Zypak stands in
for it using the sandbox Flatpak already provides, and the helper is deleted at
build time rather than shipped unusable.

## Three things that make this manifest unusual

**It builds git.** The freedesktop runtime does not ship it — measured, not
assumed:

```
$ flatpak run --command=sh org.freedesktop.Platform//25.08 -c 'command -v git'
(nothing)
```

Everything GitBraid does is a git command, so git goes in the sandbox with it.
It is built without perl, tcl/tk and gettext, which cover git's interactive
porcelain — `add -i`, `add -p`, gitk, git-gui. None of them are called: hunks
are staged by handing GitBraid's own patch to `git apply --cached`.

**It carries a newer Electron than the deb and the AppImage.** Those are pinned
to 37 because Electron 38 and up choose the native Wayland backend by default,
and that backend crashes before a window appears. The only cure is a
command-line argument, and on an ordinary desktop that would mean every launcher
having to remember one. Here the launcher is [`gitbraid.sh`](gitbraid.sh), a
file in this repository, so it cannot be forgotten — and Chromium six major
versions newer comes free.

**There is no npm anywhere in it.** GitBraid has no runtime dependencies, so
there is no lockfile to vendor, no offline mirror to generate, and nothing for
`flatpak-node-generator` to do. The application is the files it is written in:
`main.js`, `preload.js`, `src/`, `package.json`.

## What the sandbox costs

`--filesystem=home` is there because a git client is pointed at repositories the
reader chooses, and no portal offers "open a folder and keep reading it for a
whole session".

The one real limitation is **git hooks**. A hook is a script in the repository,
and it runs inside the sandbox — so a plain `#!/bin/sh` hook works, and one that
calls `node`, `python` or `npx` fails, because those are on the host and the
sandbox cannot see them. Projects using husky or pre-commit will notice. The
hook errors rather than being skipped silently, which is the better of the two
failures, but it is a difference from the deb and the AppImage.

The alternative would be `flatpak-spawn --host git`, which runs the reader's own
git with all their hooks, helpers and configuration intact. It needs
`--talk-name=org.freedesktop.Flatpak`, which is a documented way out of the
sandbox, and Flathub reviewers treat it as one. Bundling git is the version that
gets accepted without an argument, so it is the version here.

## What the linter says

```bash
flatpak install --user flathub org.flatpak.Builder
flatpak run --command=flatpak-builder-lint org.flatpak.Builder \
  manifest flatpak/io.github.heri_anggara.GitBraid.yml
```

Three findings, and only one of them was a mistake.

**`finish-args-portal-talk-name` — fixed.** The manifest asked for
`--talk-name=org.freedesktop.portal.OpenURI` so that opening a file in the
reader's editor would work. XDG portals are reachable from every sandbox
already; the permission was doing nothing but widening the surface. Removed, and
the application still runs.

**`finish-args-home-filesystem-access` and `finish-args-has-socket-ssh-auth` —
kept, and they need explaining in the submission rather than fixing.** A git
client is pointed at whichever repositories the reader chooses, and no portal
offers "open a folder and keep reading it for the length of a session"; SSH
remotes go through the agent the desktop already runs. Both are the ordinary
shape of a git client, and both are exactly the kind of thing a reviewer should
ask about.

**`appstream-external-screenshot-url` — expected.** Flathub mirrors screenshots
to its own media server when the build first runs on their infrastructure. It
reads as an error locally and resolves there.

## Building from the working tree

The manifest names a tag, pinned to its commit, because Flathub builds from it
and their farm has no working tree to reach into. To build what is checked out
instead, swap the three `type: git` lines in the last module for:

```yaml
      - type: dir
        path: ..
```

