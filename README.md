# Diff Reviewer

**Diff Reviewer** is a VS Code extension that brings an interactive, hunk-by-hunk review workflow directly into your editor. It is built for reviewing what a coding agent wrote: browse the unstaged changes in a sidebar, open any file to see its diff inline, and approve (stage) or reject (discard) individual change groups. When you are done, the index holds exactly what you approved, ready to commit.

![Diff Reviewer in action](images/preview.png)

## Features

- **Sidebar file tree** - All files with unstaged changes listed in one place, including untracked new files. Fully staged files are approved and drop out of the list
- **Multi-repository workspaces** - Open a parent folder that contains several git repositories (or a multi-root workspace) and every repository's changes are aggregated, grouped under one tree node per repository
- **Inline diff view** - Full file content with change hunks highlighted at their exact line positions - no side-by-side pane switching
- **Per-hunk approve / reject** - Approving a change group stages just that group (like `git add -p`); rejecting it reverse-applies it on disk immediately
- **Approve or reject an entire file** - One-click buttons in the sidebar context menu to bulk-approve or bulk-reject all hunks in a file
- **Undo** - Every approve and reject action can be undone with **Undo Last Action** during the session
- **Approvals live in git** - Approval state is the git index, so it survives reloads and is visible to every other git tool
- **Syntax highlighting** - Server-side highlighting via highlight.js for accurate colorization
- **Theme-aware** - Seamlessly follows VS Code light and dark themes

## Requirements

- **Git** must be installed and available on your `PATH`
- **VS Code** v1.85 or later
- Open a folder that is a Git repository, or a folder whose subfolders contain Git repositories

## Getting Started

1. Open a Git repository in VS Code (or a folder containing several)
2. Click the **Diff Reviewer** icon in the Activity Bar (left sidebar)
3. The **Unstaged Changes** panel lists all files with unstaged changes
4. Click any file to open its inline diff view
5. Use the **Approve** and **Reject** buttons on each hunk to approve or reject it

## Usage

### Reviewing a file

Click a file in the **Unstaged Changes** panel to open the diff view. Each unstaged change region (hunk) is highlighted inline within the full file; changes you already approved show as ordinary file lines. Use the action buttons on each hunk to:

- **Approve** - Stage the hunk. It becomes part of the next commit and disappears from the review
- **Reject** - Reverse-apply the hunk on disk, removing those changes from your working tree

Anything that is already staged counts as approved. If an agent or a hook ran `git add`, those changes do not show up for review; run `git reset` to review them again.

Binary files, deleted files, empty new files and file-mode changes are reviewed as a whole with **Accept file** / **Reject file**.

### Approving or rejecting an entire file

You can **Approve** (✓) or **Reject** (✗) an entire file directly from the sidebar. Approve stages the whole file (`git add`); reject discards all its unstaged changes.

### Working with several repositories

If the opened folder is not a Git repository itself, Diff Reviewer searches its subfolders for repositories (skipping hidden folders and `node_modules`). Each repository found gets its own expandable node in the **Unstaged Changes** panel with the changed files listed below it. The search depth is controlled by the `diffReviewer.repoScanDepth` setting (default: 10 levels).

### Undo

**Undo Last Action** in the sidebar title bar reverts the most recent approve (unstages it) or reject (restores it on disk). The undo history lasts for the current session. Undo refuses to act once a commit was made in that repository, because unstaging then would stage the reverse of the committed change. To unstage something outside the undo history, use `git reset -p`.

## Release Notes

See the full [CHANGELOG](CHANGELOG.md) for version history.