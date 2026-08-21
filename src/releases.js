/* Release notes, kept as data rather than prose so the page can group, count
 * and search them. One entry per shipped version, newest first.
 *
 * `state: 'development'` marks a version that has not been tagged yet — it is
 * what the build in your hands contains. Give it a date and drop the flag when
 * you tag it, then start a new entry above.
 */
window.Releases = [
  {
    version: '0.6.0',
    date: '2026-08-21',
    title: 'A newer Electron, and a diff pane that scrolls on its own layer',
    summary:
      'The engine underneath is twelve Chromium releases newer, and the diff '
      + 'pane now scrolls without dragging the change map along with it \u2014 which '
      + 'turned out to make it faster on the old engine too.',
    sections: [
      {
        heading: 'A newer Electron',
        items: [
          'Electron 31 stopped receiving Chromium security fixes long ago. This is Chromium 126 to 138 and Node 20 to 22. The application itself needed no changes at all: the API surface it uses is small and entirely core, and nothing it calls has been removed.',
          'The renderer runs sandboxed now. The preload asks for nothing Node offers \u2014 contextBridge, ipcRenderer and webUtils are all it touches, and all three exist in a sandboxed preload \u2014 so the stricter setting costs nothing.',
          'Not 43, which is the current release. Electron 38 and up choose the native Wayland backend by default, and on a GNOME Wayland session that backend crashes before a window appears \u2014 with the GPU off, with software rendering, with compositing disabled, all the same. Only a command-line argument avoids it, which would mean every way of launching the app having to remember one. 37 is the last release that still chooses X11 on its own.',
          'A switch that was supposed to control exactly that turned out never to have worked: the windowing backend is chosen before the main script runs, so asking for one from JavaScript is too late. The line was removed rather than corrected, since no value it could hold would take effect.',
        ],
      },
      {
        heading: 'The diff pane scrolls on its own layer',
        items: [
          'The newer Chromium made diff scrolling twice as slow to begin with: 10.9 ms a frame became 20.3, past the 16.7 that sixty frames a second allow.',
          'It was none of the obvious things, and each was measured out rather than reasoned away \u2014 not GitBraid\u2019s own code, not how often it redraws, not syntax colouring, not the spacer rows that stand in for the parts of a diff not on screen, not tables against grids. In a page of its own both Chromium versions scrolled the same content at the same speed, which is what showed the fault was here rather than upstream.',
          'It is the change map. The strip sits immediately beside the diff and shared its layer, so scrolling the diff repainted the strip along with it. Given a layer of its own, twelve thousand rows scroll at 11.6 ms where they took 22.9 \u2014 and at 12.3 ms on the old Chromium, where they took 12.7. This release is faster than the last one on both.',
        ],
      },
    ],
  },
  {
    version: '0.5.3',
    date: '2026-08-21',
    title: 'It opens without keeping you waiting',
    summary:
      'Launching from the dock left a loading cursor spinning for about ten '
      + 'seconds, and no icon beside it, over a window that had been on screen '
      + 'since the second.',
    sections: [
      {
        heading: 'The fix',
        items: [
          'The desktop entry asked the shell to show a launching cursor until GitBraid reported itself up, which an application does by putting the launcher\u2019s token on its first window. GitBraid never did — nothing carries that token into the process, and nothing put it on the window — so the shell waited out its own timeout instead. Measured: the app is ready at 209 ms, the window is shown at 1,986 ms, and the history is drawn at 2,222 ms. Everything after that was the shell waiting.',
          'While it waited, it had not yet decided which launcher the window belonged to — and what the dock draws comes from that launcher. So the missing icon and the spinning cursor were one thing, not two.',
          'The entry no longer asks to be waited for, which is what VS Code does on the same desktop and for the same reason.',
          'Separately, the window icon path was wrong: packaged, it pointed inside app.asar, which is an archive rather than a directory, so the file it named did not exist. A real copy ships beside the archive now. On this desktop it changes nothing visible — Electron sets no window icon there whichever way it is asked — but a path that cannot exist is worth correcting.',
        ],
      },
    ],
  },
  {
    version: '0.5.2',
    date: '2026-08-21',
    title: 'Pressing a tab selects it',
    summary:
      'A tab pressed with a hand that moved even slightly did not change. This '
      + 'is the fault behind that; 0.5.1 fixed a different one with the same '
      + 'symptom.',
    sections: [
      {
        heading: 'The fix',
        items: [
          'Selecting a tab waited for the click. A press that wandered more than five pixels was read as the beginning of a drag, and the click that would have selected the tab was thrown away with it — so the tab did not change at all. Six pixels is enough, which on a touchpad, or with any ordinary hand, is most presses.',
          'Pressing a tab now selects it there and then, the way every browser does. The five pixels of slack go back to deciding only when a drag begins. Measured across presses that move 0, 3, 6, 10 and 20 pixels: all five land on the tab that was pressed, where six and up used to land nowhere.',
          'Dragging a tab still reorders it, and the order is still kept.',
        ],
      },
    ],
  },
  {
    version: '0.5.1',
    date: '2026-08-21',
    title: 'Clicking a tab works from anywhere',
    summary:
      'One fix, for something 0.5.0 introduced the day before: with a panel '
      + 'open over the window, clicking a tab appeared to do nothing.',
    sections: [
      {
        heading: 'The fix',
        items: [
          'File history, release notes, preferences and the repository manager each cover the main view. With one of them open, clicking a tab did switch — the new tab really was active underneath — but nothing on screen moved, because the panel was still there, still showing the repository you had just left. It read exactly like a tab that could not be clicked.',
          'Clicking a tab is a request to see that repository, so anything covering it now gets out of the way first. File history goes before the rest, because closing it hands the diff panel back to the tab it was borrowed from, and that has to happen while that tab is still in front.',
          'File history arrived in 0.5.0, which is what made this feel new; the other three panels have behaved this way for as long as they have existed.',
        ],
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-08-21',
    title: 'Work on several files at once, and read where one came from',
    summary:
      'Files can be picked in groups and acted on together, any file can be '
      + 'ignored or followed back through its history, tabs can be dragged into '
      + 'the order you want them, and an update no longer takes the window away '
      + 'the moment it finishes downloading.',
    sections: [
      {
        heading: 'Several files at once',
        items: [
          'Ctrl or Cmd click adds and removes, Shift click takes a range, Ctrl+A takes the whole list. A plain click still picks one file and opens it; the modified clicks leave the open diff where it is, because picking a second file is not a request to read it.',
          'Every menu entry says how many files it will touch — "Discard changes" and "Discard 12 files" are not the same offer, and the difference cannot be undone. Right-clicking outside the selection moves it there first, so the menu never describes files that are not under the pointer.',
          'Three actions are new: discarding several, stashing several, and saving a patch of them. Discarding separates tracked from untracked, because one restores a file and the other deletes it, and the warning says which is which.',
        ],
      },
      {
        heading: 'Ignoring, and where a file came from',
        items: [
          'Ignoring adapts to what git already knows about the file. An untracked file is simply ignored, with a choice of pattern: the file, everything with its extension, or everything in its folder. A file git already tracks is offered "Stop tracking and ignore" instead, because writing a tracked path into .gitignore changes nothing at all. A deleted file gets neither.',
          'File history opens a panel of its own: the commits that touched the file on the left, the file at the chosen commit on the right. Renames are followed, and called out on the row where they happened.',
          'That panel carries the whole diff viewer — side-by-side, wrapping, the change map, jumping between differences — rather than a plainer copy of it.',
        ],
      },
      {
        heading: 'Tabs',
        items: [
          'A tab can be pressed and dragged wherever you want it. The others step aside, and the order is kept for next time.',
        ],
      },
      {
        heading: 'Updates',
        items: [
          'A finished download no longer restarts the app. It asks: restart now, or later — and later means the new version goes in when you close the app anyway, which is the moment a restart costs nothing.',
          'A half-written commit message now survives that restart, and every other one. It was carried between tabs in memory and lost on closing: nothing wrote it down. It is kept per repository, written as it is typed rather than at closing time, and cleared once committed.',
          'Release notes in the update dialog are rendered rather than printed raw. The 0.4.0 notes opened with a table, which arrived as a wall of pipes and dashes with asterisks around every emphasised word.',
        ],
      },
      {
        heading: 'Smaller things',
        items: [
          'The dock recognises the window as GitBraid straight away. It matches by the window’s WM_CLASS, which is case-sensitive, and the desktop entry claimed "GitBraid" while every window reports "gitbraid" — so the shell fell back to guessing, and the icon arrived late.',
        ],
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-08-20',
    title: 'The diff pane keeps up',
    summary:
      'A large diff now draws only the rows you can see, in every view it has. '
      + 'And when a git command fails, it says so properly instead of in a line '
      + 'of status text that the next message wipes away.',
    sections: [
      {
        heading: 'Large diffs',
        items: [
          'Only the rows on screen are drawn. A file with thousands of changed lines used to put tens of thousands of elements in the document and the browser laid out every one of them on each scroll: a 12,037-row diff held a median frame of 93 to 112 ms, about nine frames a second. It is 7 ms now, with 1,168 elements in place of 168,235. The rows left out keep their space, so the scrollbar keeps its length and nothing moves under the pointer.',
          'Side-by-side does the same. It was left out at first on the grounds that its rows are not countable — they are: a run of removals beside a run of additions is as many rows as the longer of the two. That view went from 64.1 ms a frame to 7.9.',
          'So does wrapping, which is the awkward one, because wrapped rows are not all the same height. Each row is measured once, in a hidden column of the same width under the same folding rules — one layout pass rather than a full draw, 182 ms against 786. On a 5,848-row wrapped side-by-side diff: 35.1 ms a frame down to 7, and pressing the Wrap button 786 ms down to 268.',
          'Below about six hundred rows nothing changes. That threshold was measured, not guessed: a realistic diff spread over 66 hunks is only 529 rows and already ran at 7.1 ms, where the bookkeeping would cost more than it saves.',
        ],
      },
      {
        heading: 'When a git command fails',
        items: [
          'A failed push, pull, merge or anything else opens a dialog naming what was being attempted, with the line that actually explains why — not the first line, because git opens a rejected push with the remote URL and buries the reason three lines down. The whole of git’s output follows, in its original order with nothing dropped, hints included, and it can be selected and copied.',
          'Git-Flow refuses a version number that is already tagged before touching anything. It used to fail at the tagging step, after production had already been merged, leaving main moved, no tag, development not updated and the branch still there.',
          'The Finish dialog opens straight away. It was asking the remote whether the branch existed before showing anything, so on a slow network it sat for about three seconds looking like nothing had happened. It asks after the dialog is up, and fills in the answer when it arrives: 2,930 ms down to 10.',
        ],
      },
      {
        heading: 'Reading a diff',
        items: [
          '"Wrap long lines" does something. Both the rule and the rule it was meant to switch to said the same thing, so lines always wrapped whatever the setting said.',
          'Side-by-side keeps its two halves the same width and its divider in the middle at every scroll position. It had been taking column widths from whichever row came first, which after scrolling is a spacer, so the columns collapsed to equal quarters and the left half slid into the middle of the pane.',
          'A line too long for its half is cut off at the divider with an ellipsis rather than painted across the other side. Wrap long lines shows the rest.',
          'The pane has a horizontal scrollbar of its own beneath it, always in reach. The native one sits at the bottom of the content, which on a long diff is a mile below where you are reading.',
          'The change map on the right is now the pane’s scrollbar as well as its map, and can be dragged like one. The native scrollbar beside it is gone: two indicators of one position, a few pixels apart, could only ever agree by accident — and the box marking your place had been hanging past the end of the strip, because its minimum height was never taken out of the distance it travels.',
        ],
      },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-08-19',
    title: 'Things that were quietly wrong',
    summary:
      'Small repairs, most of them found by looking at a screenshot and asking '
      + 'why something looked odd.',
    sections: [
      {
        heading: 'Text boxes',
        items: [
          'Letters with tails — g, y, j — were being clipped in some text boxes and not others. line-height: normal leaves the box height to the font, and the fonts in this stack disagree by two pixels at 13px: Cantarell asks for 16 of a 16-pixel box, Noto Sans asks for 18. Four boxes had no headroom at all, so whether a tail survived came down to which font happened to be installed. They now have room measured against the greediest font in the stack.',
          'Dialogs no longer mark branch names, URLs and paths as misspelt. They are identifiers, not prose. The commit message keeps its spell check, being the one box here whose words other people read.',
        ],
      },
      {
        heading: 'Faces and marks',
        items: [
          'The commit panel shows the author\u2019s photograph when there is one. It could only ever draw initials before, so it disagreed with the Author column beside it.',
          'The change map keeps quiet when the whole diff is already on screen. A mark\u2019s height is a share of the diff, so the shorter the diff the bigger each mark: on a +16 \u22121 diff two marks filled 47% of the strip while nothing at all was hidden. A mark is also capped at a quarter of the strip, for a diff that scrolls by only a line or two.',
        ],
      },
      {
        heading: 'Buttons',
        items: [
          'Browse, Clone, Init and Scan a folder each carry an icon, and every button in that row is the same height. The close button beside them had been flattened to half height by a style rule that took over a class it did not own — which cost the release notes\u2019 close button too.',
          'Help \u25b8 Check for Updates\u2026 asks at any time, rather than the version button in the status bar being the only way in. Asked by hand, an answer of "there is one" now opens the offer instead of only lighting a dot.',
        ],
      },
      {
        heading: 'Written down correctly',
        items: [
          'The README said syntax colouring covered around fifteen languages. It covers eleven, across some thirty file extensions, which is what Preferences had said all along.',
          'Its screenshots were wrong too: every light-theme picture was of the pane left over from the dark-theme pass, because an open file hides the history behind it. The commit list now leads, at full width, where the columns are readable.',
        ],
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-08-19',
    title: 'It updates itself, and it stops guessing',
    summary:
      'GitBraid can now fetch its own new version, and several places where it '
      + 'showed something invented or out of date now go and find out instead.',
    sections: [
      {
        heading: 'Updating from inside the app',
        items: [
          'The version button in the status bar takes a dot when a newer release exists, and opens the notes and one button. An AppImage downloads, verifies, replaces itself and restarts; a .deb is handed to your system installer, because installing a system package needs rights this app does not have and should not ask for.',
          'A download is always checked against the SHA-512 published with the release, and refused outright when that checksum is missing rather than installed on trust — this replaces the program you run.',
          'The check runs once a day on opening, can be switched off, and tells GitHub only that GitBraid is running. Written on node\u2019s own https and crypto: GitBraid still ships no runtime dependencies at all.',
        ],
      },
      {
        heading: 'Author pictures that are actually somebody',
        items: [
          'A face is now fetched from GitHub when the commit address is one GitHub issued — the account number is inside the address, so no API and no token are involved.',
          'Gravatar is asked with d=404 rather than d=identicon. The old setting meant an address with no Gravatar was answered with a pattern generated from it, which arrived as an image like any other: every author looked photographed. An address with no picture anywhere now keeps its disc of initials.',
          'Where a face appears is yours to choose: on the graph dot, in the Author column, both, or nowhere.',
        ],
      },
      {
        heading: 'Reading a diff',
        items: [
          'A strip beside the scrollbar shows where the changes are — one mark per block, green, red, or both — and clicking one goes to that difference, carrying the 2/12 counter with it.',
          'The file name and its counts are no longer printed twice; the diff\u2019s own header now appears only when more than one file is on screen.',
        ],
      },
      {
        heading: 'Getting around',
        items: [
          'Commit search has a field you can see, above the history, instead of living only behind Ctrl+F.',
          'File lists have one setting with three shapes — path list, file and dir list, filesystem tree — shared by both panels, chosen from a menu of pictures.',
          'The Graph column can be hidden and dragged like any other, and the details panel folds to a rail rather than only disappearing.',
          'The repository and branch header is one box with icons in place of the two captions that used to take a line each.',
        ],
      },
      {
        heading: 'Correctness',
        items: [
          'An annotated tag now points at the commit it marks. Clicking one used to search the history for the tag object\u2019s own hash, which no commit has, and quietly do nothing.',
          'Whether a flow branch is on the remote is asked of the remote, not read from tracking refs that are only as fresh as the last fetch. Offline, the dialog says the answer is unknown rather than pretending the branch is not there.',
          'A repository\u2019s remote URL can be changed from the menu, which reads back what git actually holds afterwards.',
          'Dialogs no longer shout their sentences. A rule meant for field captions was putting whole explanations in capitals, branch names included — and a ref\u2019s case is part of what it is.',
          'Text in the chrome can no longer be selected, so double-clicking a branch to check it out stops smearing its name in blue.',
        ],
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-08-19',
    title: 'Big histories, and nothing moved behind your back',
    summary:
      'A repository with thousands of commits now scrolls like a small one, and '
      + 'the actions that change it ask first.',
    sections: [
      {
        heading: 'Only the rows you can see are drawn',
        items: [
          'Every loaded commit used to become a real element in the page. On a history of 8,951 commits that is 124,490 nodes in the list and 27,170 in the graph, and the browser paid for all of them on every scroll: a median frame of 67.9 ms, about 15 frames a second.',
          'The list now holds roughly a screenful — around 600 nodes — with a margin above and below, so an ordinary scroll usually redraws nothing at all. The median frame is 7.0 ms, and it stays there whether the history is 400 rows or 8,951.',
          'The graph draws only the band in view, but a line crossing the screen from a commit far above to its parent far below is still drawn. That was checked against a reference calculation over 65 different bands, all containing merges, with no difference.',
          'The 400-commit limit was never a git cost. Reading all 8,951 commits takes 40 ms against 35 ms for 400 — drawing them was the expense.',
        ],
      },
      {
        heading: 'Switching tabs shows what the tab already had',
        items: [
          'A tab switch re-read and re-drew the whole history before showing anything, so a tab holding 9,000 commits took 3.3 seconds to come back. It now paints from what the tab is already holding and lets git catch up behind it: about 90 ms for that tab, about 20 ms for a small one.',
          'A refresh that outlives the switch that started it now returns its answer to the tab that asked, so it can no longer land on whichever repository happens to be in front.',
        ],
      },
      {
        heading: 'Looking at a branch no longer checks it out',
        items: [
          'One click on a branch, tag or remote branch moves the history to its tip. If that commit is not loaded yet, GitBraid widens the history until it is.',
          'Checking out takes a double-click. A single click used to do it, so browsing the sidebar changed the repository under you — and on a tag it dropped you into a detached HEAD without asking.',
          'When tracked files have uncommitted changes, a dialog asks first: stash and reapply, bring the changes along, or discard them. Files git does not track are neither counted nor touched, because a checkout never removes them. A switch that git refuses puts the stash back, and a reapply that conflicts keeps the stash and says so.',
        ],
      },
      {
        heading: 'Merging says which way round it goes',
        items: [
          'Merging ran the moment it was clicked. It now shows the direction, how many commits are coming in, how many the current branch has of its own, and whether a fast-forward is possible — merging the wrong way round is the mistake that actually happens, and no button label shows it.',
          'Three choices: git\u2019s own behaviour, always create a merge commit, or squash into one staged change. A branch already contained gets no dialog, only a line saying there is nothing to merge.',
        ],
      },
      {
        heading: 'Finishing a git-flow branch finishes it on the remote too',
        items: [
          'Finishing merged and deleted the branch here, and stopped. Nothing was pushed and nothing on the server was touched, so you were left with development ahead of its remote, the branch still hanging on origin, and — for a release — the tag on one machine only.',
          'The dialog now offers to push the result and to delete the branch on the remote, both on by default, and the delete only appears when the branch is actually published.',
          'The push runs before anything is removed from the server. If it is refused because someone else moved development first, the finish stops with the branch still on the remote, where it is the only copy of that work there.',
        ],
      },
      {
        heading: 'Smaller things',
        items: [
          'An annotated tag now points at the commit it marks. Clicking one searched the history for the tag object\u2019s own hash, which no commit has, and quietly did nothing; every annotated tag also sorted to the bottom of the list with a date of 1970.',
          'Text in the chrome — sidebar, toolbar, tabs, commit list, status bar — can no longer be selected. Diffs, terminal output, commit messages, the command log and these notes still can.',
          'A step that fails during a git-flow finish reports the line that explains it. A refused push opens with "To <url>", which says nothing.',
        ],
      },
    ],
  },
  {
    version: '0.1.2',
    date: '2026-08-18',
    title: 'Nothing leaves the machine',
    summary:
      'GitBraid talks to the git on your computer and nothing else. One thing '
      + 'did not follow that rule, and now it does.',
    sections: [
      {
        heading: 'Author photos are something you ask for',
        items: [
          'Opening a repository sent one request to gravatar.com for every commit author on screen. That tells the service your address and the hashed email of everyone whose commits you are reading — colleagues included, on a private work repository. It also failed offline and delayed every repository opened.',
          'The graph now draws the plain lane-coloured dot, which says as much without any network at all. Verified by intercepting every request the app makes: none leave the machine.',
          'If you want the photos, Preferences → UI customization turns them on, and says plainly what switching them on means.',
        ],
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-08-18',
    title: 'Reporting the truth, and holding less memory',
    summary:
      'Five fixes on the first build: two places where the app claimed something '
      + 'that had not happened, two where it kept work it no longer needed, and a '
      + 'guard on the one command that cannot be undone.',
    sections: [
      {
        heading: 'Said what did not happen',
        items: [
          'A merge, pull or rebase that git completes without changing anything now says so. Merging a branch already contained in yours reported "Merged" in success green while nothing moved; the branch menu also marks an already-merged branch before you click it.',
          'The progress bar left over from a push no longer sits in the status bar. It stayed lit after every push, and in a flex row it pushed the zoom and version controls away from the right edge.',
        ],
      },
      {
        heading: 'Kept less',
        items: [
          'Closing a file releases its diff. A diff of an 8,000-line file is around 110,000 DOM nodes, and they stayed in the document for the rest of the session; opening several large files in a row grew the window without bound.',
          'The terminal panel no longer measures the panel before every line it writes. Doing so forced a full layout each time, so 2,000 lines took 2.7 seconds where appending them costs 3 ms — it is 34 ms now. Scrollback is capped at 5,000 lines, which it never was.',
        ],
      },
      {
        heading: 'Safer',
        items: [
          'Discarding checks what it was handed. The file list is spread into the command, so a bare string would have spread into single letters and an empty list would have left git clean with no path at all — which cleans the whole working tree. Neither was reachable from the app; both would have been unrecoverable.',
        ],
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-08-18',
    title: 'First working build',
    summary:
      'A Git client that reads history as coloured lanes, with per-hunk staging, ' +
      'a full-width diff viewer, and branch work driven from context menus.',
    sections: [
      {
        heading: 'Repositories and tabs',
        items: [
          'Several repositories open at once in tabs, each keeping its own history, selection, scroll position and commit draft.',
          'Reopening a repository already open moves focus to its tab instead of adding a second one.',
          'Repository management page: Open, Favorites, Recent and All, with a folder scan that skips node_modules and friends.',
          'Optional WIP summary showing how many files are uncommitted in every listed repository.',
          'Search Tabs, and a start page that appears in a New Tab rather than replacing the window.',
          'On launch GitBraid brings back every tab from the last session, on the tab you were looking at; the start page is for a genuinely fresh install.',
        ],
      },
      {
        heading: 'History and graph',
        items: [
          'Commit graph drawn as coloured lanes, with branch, remote and tag badges in their own column.',
          'Columns can be resized by dragging the header, and switched off from a right-click menu — including an Author Time column.',
          'Hovering a row shows the whole commit message, and a ghost badge naming the branch that contains it.',
          'Ctrl+F searches subjects, bodies, authors, emails and SHAs; misses fade rather than disappear so the graph stays whole.',
        ],
      },
      {
        heading: 'Diffs',
        items: [
          'Clicking a file opens it across the middle of the window, not squeezed into a side panel.',
          'Side-by-side view pairs a removed line with the line that replaced it.',
          'Jump between changed blocks with a counter, buttons, or Alt+Arrow keys.',
          'Show-all-lines turns the diff into the whole file; ignore-whitespace hides changes that are only spacing.',
          'Syntax colouring for TypeScript, JavaScript, JSON, CSS, HTML, Markdown, SQL, shell, Python, YAML, Go and Rust, written in-house so the app carries no runtime dependency.',
        ],
      },
      {
        heading: 'Staging and commits',
        items: [
          'Stage, unstage and discard by file or by hunk.',
          'Commit summary and description are separate fields, with a length counter that warns past 50 and 72 characters.',
          'The uncommitted-changes list switches between List, which shows file names alone, and Tree, which groups them into folders and folds single-child folder chains into one row.',
          'Filter the changed-file list; untracked folders are listed file by file so new files can be staged individually.',
          'A merge commit offers the three readings git can give it — what it brought in, what the other side had, and what a person resolved by hand — each with its file count, and both parents as chips you can jump to.',
          'A merge, rebase, cherry-pick or revert that git stopped part-way through announces itself across the window, with Abort and Continue, a count of what is left, and conflicted files in a group of their own.',
          'Conflicts are settled per file — keep yours, keep theirs, or mark resolved — and the commit button stays locked until none are left.',
          'Pull tries fast-forward first and asks whether to merge or rebase when the histories have diverged, rather than deciding the shape of your history for you.',
          'A merge, pull or rebase that git completes without changing anything says so, instead of reporting success for work that did not happen; the branch menu marks an already-merged branch before you click it.',
          'Reword a commit in place. HEAD is amended; an older commit rebases the ones after it, and says how many before you agree.',
        ],
      },
      {
        heading: 'Branches, remotes and Git-Flow',
        items: [
          'The repository name in the sidebar opens actions for the repository already open — copy its path or remote URL, open it in the file manager, a terminal or a code editor, favorite it — rather than a fourth way to open a different one.',
          'Context menus for local branches, remote branches and tags: checkout, fast-forward, fetch into, push, merge, rebase, compare, rename, tracking branch, description, delete.',
          'Entries that cannot run stay visible and explain why on hover.',
          'Git-Flow implemented on plain git, writing the same gitflow.* config keys the command line tool uses.',
        ],
      },
      {
        heading: 'Around the app',
        items: [
          'Light and dark themes, window zoom from 58% to 207%, and collapsible side panels.',
          'Tooltips drawn by the app rather than the desktop, so they follow the theme and stay inside the window.',
          'Files open in an installed code editor instead of being handed to the desktop, which used to download source files instead of opening them.',
          'Git identity shown and editable from the title bar, per repository or globally.',
          'A terminal panel along the bottom, opened with Ctrl+`, running commands in the active tab\'s repository and remembering its height between sessions.',
          'Activity log listing every git command the app ran, with how long each took, and a Copy button for bug reports.',
          'Status bar carrying zoom controls, the version number, and a link to the project page.',
          'Every Git command reports itself on the button that started it: the icon becomes a spinner, the label carries the phase and percentage git reports, a hairline of progress runs along the toolbar, and the result lands as a green tick or a red cross.',
          'Failure messages pick the line that explains the failure, so a rejected push says what was rejected and a conflicted merge names the file, instead of quoting the command back at you.',
          'Preferences with four pages — General, Profiles, UI customization and Editor — where the default branch name and the external editor are written to your own git config rather than kept privately, so the command line agrees with them.',
        ],
      },
    ],
    known: [
      'Only ever run on Linux. The code handles macOS and Windows and the builds are configured for them, but neither has been tried.',
      'Interactive rebase has no editor yet — rewording is supported, reordering and squashing are not.',
      'Conflicts are resolved a whole file at a time — take yours, take theirs, or edit the file and mark it resolved. There is no line-by-line merge tool.',
      'No GitHub or GitLab integration, so pull requests cannot be created from here.',
      'Submodules and worktrees are read but have no dedicated panels.',
      'Opening a system terminal on a GNOME desktop where Ptyxis is not yet running leaves one extra default window alongside the one at the repository, which is Ptyxis\'s own activation behaviour.',
      'The terminal panel captures output rather than providing a TTY, so full-screen programs such as vim and top cannot run inside it.',
    ],
  },
];
