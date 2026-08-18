# Screenshots

These are the images `build/linux/io.github.heri_anggara.GitBraid.metainfo.xml`
points at. Flathub will not accept a listing without them.

| File | Shows |
|---|---|
| `history.png` | The commit graph — lanes, branch and tag badges, and a merge commit with both parents and the three readings git can give it |
| `diff.png` | Side-by-side diff with syntax colouring, old on the left and new on the right |
| `conflict.png` | A suspended merge: the banner with Abort and Continue, the Conflicts group, and the markers in the file |
| `history-light.png` `diff-light.png` `conflict-light.png` | The same three in the light theme |

Six is more than a listing needs, and the light set repeats what the dark set
already shows. If the carousel feels long, drop the three `-light` entries from
`build/linux/io.github.heri_anggara.GitBraid.metainfo.xml` and keep one of them
— that is enough to say the light theme exists.

## Nothing here is real

Every one of them is taken against a repository built by
[`make-demo.sh`](make-demo.sh) — a fictional static site generator called
Inkwell, with invented commits, invented co-authors, and a conflict staged on
purpose. A store page is public and permanent, so no real repository appears in
it: no work repository names, no branch names, no commit messages, no file
contents.

## Taking them again

```bash
./screenshots/make-demo.sh          # builds ~/Documents/Project Pribadi/gitbraid-demo/inkwell
```

The demo has five branches, two tags, three authors, dates that walk from
February 2026 rather than all landing on today, and work left uncommitted so
the right-hand panel is not empty. For the conflict shot, inside the demo repo:

```bash
git stash push -u        # the merge refuses to start over uncommitted work
git merge develop        # conflicts in src/args.js, on purpose
# … take the screenshot …
git merge --abort && git stash pop
```

Window was 1600×1000 at 100% zoom, once in each theme. The light set was
taken with the same commit and the same file selected, so the two can be read
side by side.
