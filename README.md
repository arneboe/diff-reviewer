# Diff Reviewer

**Diff Reviewer** is a VS Code extension that brings an interactive, hunk-by-hunk review workflow directly into your editor. It is built for reviewing what a coding agent wrote: browse the unstaged changes in a sidebar, open any file in the normal editor with its changes highlighted, and approve (stage) or reject (discard) individual change groups. When you are done, the index holds exactly what you approved, ready to commit.

![Diff Reviewer in action](images/preview.png)

## Features

- **Sidebar file tree** - All files with unstaged changes listed in one place, including untracked new files. Fully staged files are approved and drop out of the list
- **Multi-repository workspaces** - Open a parent folder that contains several git repositories (or a multi-root workspace) and every repository's changes are aggregated, grouped under one tree node per repository
- **Review in the editor** - A file opens as an index ↔ working-tree diff: removed lines as red rows, added lines green, and the right side is the real file, so Ctrl+click, search, editing and the hovers of your other extensions keep working. A global **review mode** switches the actions on and off
- **Per-hunk approve / reject** - An **Approve** / **Reject** CodeLens above each change group; approving stages just that group (like `git add -p`), rejecting reverse-applies it on disk immediately
- **Approve or reject an entire file** - One-click buttons in the sidebar context menu to bulk-approve or bulk-reject all hunks in a file
- **Undo** - Every approve and reject action can be undone with **Undo Last Action** during the session
- **Approvals live in git** - Approval state is the git index, so it survives reloads and is visible to every other git tool
- **Theme-aware** - Highlights use the diff colours of your VS Code theme

## Requirements

- **Git** must be installed and available on your `PATH`
- **VS Code** v1.85 or later
- Open a folder that is a Git repository, or a folder whose subfolders contain Git repositories

## Getting Started

1. Open a Git repository in VS Code (or a folder containing several)
2. Click the **Diff Reviewer** icon in the Activity Bar (left sidebar)
3. The **Unstaged Changes** panel lists all files with unstaged changes
4. Click any file: it opens as a diff against the index and review mode switches on
5. Use the **Approve** / **Reject** CodeLens above each hunk to approve or reject it

## Usage

### Reviewing a file

Click a file in the **Unstaged Changes** panel. It opens in VS Code's diff editor with the index version on the left and your working-tree file on the right, and **review mode** switches on. In the inline view, removed lines are red rows and added lines green, exactly where they sit in the file. The right side is the real file, so you can edit it, search it, jump to definitions and read the hovers of your other extensions. Each unstaged change region (hunk) gets a CodeLens with two actions:

- **Approve** - Stage the hunk. It becomes part of the next commit and disappears from the review
- **Reject** - Reverse-apply the hunk on disk, removing those changes from your working tree

The first line of the file carries **Approve file** / **Reject file**, the number of hunks left, and **Exit review mode**. Approving a hunk stages it, the index side reloads and the hunk vanishes from the diff. After the last hunk of a file is handled, the next file to review opens.

Anything that is already staged counts as approved. If an agent or a hook ran `git add`, those changes do not show up for review; run `git reset` to review them again.

Untracked files, empty new files and file-mode changes are reviewed as a whole with the file-level CodeLens. Deleted and binary files have no editor to show; approve or reject them with the buttons next to them in the sidebar.

### Review mode

Review mode is global: while it is on, every visible editor whose file has unstaged changes gets the Approve / Reject CodeLenses, and a plain (non-diff) editor also gets its added lines highlighted; while it is off, nothing is drawn and the editor behaves exactly as usual. The diff tabs stay open either way. Toggle it with the **Review** item in the status bar, the eye button in the sidebar title, or the commands **Toggle / Enable / Disable Review Mode**. It is off after every window reload until you turn it on or click a file in the sidebar.

Editing a file while reviewing is fine. As soon as the editor has unsaved changes, the highlights turn into dimmed markers that follow your edits and the CodeLens asks you to save; after saving, the diff is re-read and the highlights return.

### Keyboard-driven review

No keybindings are shipped, so nothing collides with your setup. Bind the commands you need in **Preferences: Open Keyboard Shortcuts**:

| Command | What it does |
|---|---|
| `diffReviewer.approveHunkAtCursor` | Approve the hunk at (or next below) the cursor |
| `diffReviewer.rejectHunkAtCursor` | Reject the hunk at (or next below) the cursor |
| `diffReviewer.nextHunk` / `diffReviewer.previousHunk` | Move the cursor to the next / previous hunk |
| `diffReviewer.approveActiveFile` / `diffReviewer.rejectActiveFile` | Approve / reject the whole active file |
| `diffReviewer.toggleReviewMode` | Switch review mode on or off |

### Tips

- VS Code hides CodeLens in diff editors by default. On your first review the extension offers to set `"diffEditor.codeLens": true` and `"diffEditor.renderSideBySide": false` (inline view) for the workspace; you can also set them yourself. Without `diffEditor.codeLens` the Approve / Reject lenses do not show in the diff, but the cursor commands still work
- Switch between the inline and the side-by-side view with the toggle in the diff editor's title bar

### Approving or rejecting an entire file

You can **Approve** (✓) or **Reject** (✗) an entire file directly from the sidebar or with the file-level CodeLens in the editor. Approve stages the whole file (`git add`); reject discards all its unstaged changes.

### Working with several repositories

If the opened folder is not a Git repository itself, Diff Reviewer searches its subfolders for repositories (skipping hidden folders and `node_modules`). Each repository found gets its own expandable node in the **Unstaged Changes** panel with the changed files listed below it. The search depth is controlled by the `diffReviewer.repoScanDepth` setting (default: 10 levels).

### Undo

**Undo Last Action** in the sidebar title bar reverts the most recent approve (unstages it) or reject (restores it on disk). The undo history lasts for the current session. Undo refuses to act once a commit was made in that repository, because unstaging then would stage the reverse of the committed change. To unstage something outside the undo history, use `git reset -p`.

## Release Notes

See the full [CHANGELOG](CHANGELOG.md) for version history.