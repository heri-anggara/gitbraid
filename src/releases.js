/* Release notes, kept as data rather than prose so the page can group, count
 * and search them. One entry per shipped version, newest first.
 *
 * `state: 'development'` marks a version that has not been tagged yet — it is
 * what the build in your hands contains. Give it a date and drop the flag when
 * you tag it, then start a new entry above.
 */
window.Releases = [
  {
    version: '0.1.0',
    state: 'development',
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
