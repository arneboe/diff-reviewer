# Diff Reviewer

**Diff Reviewer** is a VS Code extension that brings an interactive, hunk-by-hunk review workflow directly into your editor. Browse your uncommitted changes in a sidebar, open any file to see its diff inline, and approve or reject individual change groups - all without leaving VS Code.

![Diff Reviewer in action](images/preview.png)

## Features

- **Sidebar file tree** - All files with uncommitted changes (staged + unstaged vs HEAD) listed in one place, including untracked new files
- **Multi-repository workspaces** - Open a parent folder that contains several git repositories (or a multi-root workspace) and every repository's changes are aggregated, grouped under one tree node per repository
- **Inline diff view** - Full file content with change hunks highlighted at their exact line positions - no side-by-side pane switching
- **Per-hunk approve / reject** - Review each change group independently; rejecting a hunk reverse-applies it on disk immediately
- **Approve or reject an entire file** - One-click buttons in the sidebar context menu to bulk-approve or bulk-reject all hunks in a file
- **Undo everything** - Every approve and reject action is fully undoable
- **Stable hunk tracking** - Approvals are keyed by content, not line number, so they survive when other hunks shift position after edits
- **Syntax highlighting** - Server-side highlighting via highlight.js for accurate colorization
- **Theme-aware** - Seamlessly follows VS Code light and dark themes

## Requirements

- **Git** must be installed and available on your `PATH`
- **VS Code** v1.85 or later
- Open a folder that is a Git repository, or a folder whose subfolders contain Git repositories

## Getting Started

1. Open a Git repository in VS Code (or a folder containing several)
2. Click the **Diff Reviewer** icon in the Activity Bar (left sidebar)
3. The **Modified Files** panel lists all files with uncommitted changes
4. Click any file to open its inline diff view
5. Use the **Approve** and **Reject** buttons on each hunk to approve or reject it

## Usage

### Reviewing a file

Click a file in the **Modified Files** panel to open the diff view. Each changed region (hunk) is highlighted inline within the full file context. Use the action buttons on each hunk to:

- **Approve** - Mark the hunk as reviewed (no disk change)
- **Reject** - Reverse-apply the hunk on disk, removing those changes from your working tree

### Approving or rejecting an entire file

You can **Approve** (✓) or **Reject** (✗) an entire file directly from the sidebar. This applies the action to every pending hunk in the file at once.

### Working with several repositories

If the opened folder is not a Git repository itself, Diff Reviewer searches its subfolders for repositories (skipping hidden folders and `node_modules`). Each repository found gets its own expandable node in the **Modified Files** panel with the changed files listed below it. The search depth is controlled by the `diffReviewer.repoScanDepth` setting (default: 10 levels).

### Undoing an approval

After approving a hunk, hover the mouse on top of the "APPROVED" label, it will turn into an "UNDO" button. WARNING: Rejected hunks can't be undone.

## Building from Source

### With Docker (recommended)

You only need Docker with BuildKit, which recent Docker versions enable by default. Run from the repository root:

```bash
docker build --output type=local,dest=dist .
```

This runs lint and the tests, then packages the extension. The resulting `diff-reviewer-<version>.vsix` is written to `dist/`. Change `dest=` to write it to another folder. If lint or a test fails, the build stops and no `.vsix` is written.

Optional build arguments:

- `--build-arg NODE_VERSION=22` - Node.js major version of the build image (default: 22)
- `--build-arg VSCE_VERSION=3` - version of `@vscode/vsce` used for packaging (default: 3)

### Locally

You need Node.js 22 (see `.nvmrc`) and Git.

```bash
npm ci
npm run lint
npm test
npx @vscode/vsce package
```

`vsce package` runs the esbuild build (`npm run build`) and writes the `.vsix` to the repository root. During development, use `npm run watch` to rebuild on every change.

### Installing the `.vsix`

```bash
code --install-extension dist/diff-reviewer-<version>.vsix
```

Or in VS Code: **Extensions** view → **⋯** menu → **Install from VSIX...**

## Release Notes

See the full [CHANGELOG](CHANGELOG.md) for version history.