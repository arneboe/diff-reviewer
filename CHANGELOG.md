# Changelog

All notable changes to **Diff Reviewer** are documented in this file.

## [2.1.0] — 2026-09-29

### Added
- When an approve or reject finishes the file shown in the diff view, the next file to review opens automatically

### Changed
- Approve and reject update only the affected file. File and git-index changes re-read only the repository they belong to. Repository discovery runs only at startup, when workspace folders or `diffReviewer.repoScanDepth` change, when a repository appears, and on Refresh; approving in a folder with many repositories no longer takes seconds

### Fixed
- An approve or reject clicked while a refresh was running could act on a stale diff; all git actions and refreshes now run one at a time
- A refresh that arrived before a new diff view finished loading was lost

## [2.0.0] — 2026-09-29

### Changed
- **Approve now stages.** Approving a hunk runs `git apply --cached` for just that change group; approving a file runs `git add`. The git index is the approval state, so the next commit contains exactly what was approved
- The sidebar ("Unstaged Changes") and the diff view show only unstaged changes (index → working tree) and untracked files. Anything already staged counts as approved and is not shown; fully approved files leave the sidebar
- Approved hunks are no longer drawn as highlighted blocks; they appear as ordinary file lines
- Undo of an approval unstages it. Undo is refused once a commit was made in that repository
- Refresh no longer clears approvals
- Renames are shown as a deletion plus an addition

### Added
- Deleted files, binary files, empty new files and file-mode changes are listed and can be approved or rejected as a whole
- Watcher on each repository's `.git/index` and `HEAD`, so `git add`, `git reset` and `git commit` from a terminal update the sidebar
- Welcome texts for "everything is staged" and "no changes"

### Fixed
- Deleted files were keyed as `/dev/null`
- Patches for the last line of a file without a trailing newline failed because the marker was dropped when splitting hunks
- Duplicate-content hunks could receive colliding IDs
- The options menu in the diff view registered a new document click listener on every render

### Removed
- Stored approvals in workspace state (`diffReviewer.hunkStatuses`); they are deleted on first activation
- The per-hunk "approved" badge and its hover undo

## [1.2.2] — 2026-09-29

### Changed
- Repository, issues, and discussions URLs in `package.json` now point at github.com/arneboe/diff-reviewer

## [1.2.1] — 2026-09-29

### Changed
- Repositories without any uncommitted changes are no longer shown in the sidebar tree

## [1.2.0] — 2026-09-29

### Added
- Multi-repository support: when the opened folder is not itself a git repository, nested repositories are discovered automatically (up to `diffReviewer.repoScanDepth` levels deep, default 10) and their changes are aggregated
- Sidebar groups files under one expandable node per repository when more than one repository is present, with file and pending counts per repository; a single repository keeps the flat list
- Multi-root workspaces: every workspace folder is scanned, and repositories are re-discovered when folders are added or removed
- `diffReviewer.repoScanDepth` setting
- Welcome message in the sidebar when no repository is found

### Changed
- Hunk statuses, undo entries, and diff panels are now keyed by repository and path, so identical relative paths in different repositories no longer collide. Approvals persisted by earlier versions are discarded on first load
- Extension now also activates on startup so nested repositories are picked up without a `.git` at the workspace root

### Fixed
- Rejecting the last remaining hunk of a tracked file no longer re-renders the whole file as a newly added untracked file

## [1.1.1] — 2026-02-25

### Fixed
- Add missing `activationEvents` property required by `vsce` for extensions with a `main` entry point

## [1.1.0] — 2026-02-25

### Added
- Untracked files (never staged) now appear in the pending list and can be reviewed hunk-by-hunk
- Binary and non-text files (images, PDFs, archives, videos, fonts, compiled binaries, etc.) are automatically excluded from the diff tree
- Undo support extended to cover reject actions on untracked files

## [1.0.1-rc] — 2026-02-25

### Fixed
- Floating action bar now hides correctly when all hunks in a file have been reviewed

## [1.0.0-rc] — 2026-02-25

### Added
- Floating action bar with hunk navigation, approve-all / reject-all, and settings controls
- Scroll map markers indicating positions of pending and approved hunks in the file
- Modified file count badge on the sidebar tree view

### Fixed
- Auto-scroll toggle is now correctly respected when a file is first rendered

## [0.0.2-beta] — 2026-02-25

### Added
- Git repository root discovery for monorepo support
- File count badge on the sidebar tree view
- `.vscodeignore` to exclude dev files from the packaged extension
- MIT `LICENSE` file
- `vscode:prepublish` script to auto-build before packaging

### Fixed
- File tree badge rendering improvements
- More reliable git root resolution in nested workspaces

## [0.0.1-beta] — 2026-02-19

### Added
- Initial release with full interactive diff review workflow
- Sidebar file tree listing all files with uncommitted changes
- Per-file webview panel rendering the full file with hunks inline
- Approve and reject actions on individual hunks (granular sub-hunk splitting)
- Rejecting a hunk reverse-applies it on disk via `git apply -R`
- Content-based hunk IDs (FNV-1a) for stable tracking across re-parses
- Undo stack for all approve/reject actions
- Approve-file and reject-file shortcuts from the sidebar context menu
- Server-side syntax highlighting via highlight.js
- Light/dark theme support via VS Code CSS variables
- Approved hunk status persisted across sessions via `vscode.Memento`
- CI workflow with GitHub Actions
