# Screenshots

These are the images `build/linux/io.github.heri_anggara.GitBraid.metainfo.xml`
points at. Flathub will not accept a listing without them.

| File | Shows |
|---|---|
| `history.png` | The commit graph with the details panel open — lanes, branch and tag badges, two stashes drawn as dashed rings, and a merge commit with both parents and the three readings git can give it |
| `commits.png` | The same history with the panel folded away, which is the only way the message, author, date and SHA columns all get room to be read |
| `diff.png` | A whole-file diff with syntax colouring and the change map down the right-hand edge |
| `conflict.png` | A suspended merge: the banner with Abort and Continue, the Conflicts group, and the markers in the file |
| the four `-light.png` twins | The same four in the light theme |

Eight is more than a listing needs, and the light set repeats what the dark set
already shows. If the carousel feels long, drop three of the `-light` entries
from `build/linux/io.github.heri_anggara.GitBraid.metainfo.xml` and keep one —
that is enough to say the light theme exists.

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

The demo has five branches, two tags, three authors, **two stashes** — one of
them carrying an untracked file, which lives on a third parent a plain diff
never looks at — dates that walk from February 2026 rather than all landing on
today, and work left uncommitted so the right-hand panel is not empty.

`shoot.js` does the conflict itself. By hand, inside the demo repo:

```bash
git stash push -u        # the merge refuses to start over uncommitted work
git merge develop        # conflicts in src/args.js, on purpose
# … take the screenshot …
git merge --abort && git stash pop
```

Window is 1600×940 at 100% zoom, once in each theme. The light set is taken
with the same commit and the same file selected, so the two can be read side by
side.
