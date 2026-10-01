# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension for interactive diff review. Built for reviewing what a coding agent wrote. It shows unstaged changes (index → working tree) and untracked files from every git repository in the workspace in a sidebar file tree. Clicking a file opens it in the normal text editor and turns on a global *review mode* that decorates every visible editor with unstaged changes: added lines highlighted, removed lines in read-only comment widgets, Approve/Reject CodeLenses per hunk and per file. Review mode off means no decorations and a normal editor. Approving stages the hunk via `git apply --cached`; rejecting reverse-applies it on disk via `git apply -R`. The git index is the approval state. Actions are undoable for the session.

## Commands

- `npm run build` — Bundle the extension with esbuild (output in `out/`)
- `npm run watch` — Watch mode for development
- `npm test` — Run tests (uses Node.js built-in test runner with tsx; needs Node ≥ 20, run `nvm use 24` first if the system node is older)
- `npm run lint` — ESLint + TypeScript type check (`tsc --noEmit`)
- `npm run lint:fix` — Auto-fix ESLint issues
- `npm run ts:check` — Type check only
- Run a single test file: `node --import tsx --test test/diffParser.test.ts`

Pre-commit hook runs `npm run lint:fix && npm run ts:check`.

## Architecture

**One build target** (see `esbuild.mjs`): `src/extension.ts` → `out/extension.js`, Node/CommonJS, externals `vscode`. `media/` holds only the activity-bar icon.

**Extension-side modules** (`src/`):
- `extension.ts` — Activation, command registration (sidebar, CodeLens targets, cursor commands), wiring between the tree, the review-mode controller and the state manager
- `git/repoDiscovery.ts` — Finds git repositories for the workspace folders: a folder inside a work tree yields that repo; otherwise subfolders are scanned (depth from `diffReviewer.repoScanDepth`)
- `git/repoManager.ts` — One `GitAdapter` per discovered repo; aggregates `getDiff()` across repos, reports per-repo HEAD / staged state / git dir, and resolves the adapter for a `repoRoot`
- `git/gitAdapter.ts` — Shells out to `git` CLI within a single repo: unstaged diff (`git diff`, no `HEAD`), untracked files, `git apply` (worktree and `--cached`, forward/reverse), `git add`, index-entry read/restore (incl. intent-to-add), `checkout-index`; stamps `repoRoot` on every `DiffFile`
- `git/diffParser.ts` — Parses unified diff text into `DiffFile`/`DiffHunk` structures (paths from the `diff --git` line, file kind, mode changes, no-newline markers), then `splitHunks()` breaks each hunk into granular sub-hunks (one per contiguous change group). `buildPatch()` turns one sub-hunk into a `git apply --unidiff-zero` patch. Content-based hunk IDs (FNV-1a) let a CodeLens address a hunk safely after the file was re-read
- `state/stateManager.ts` — Executes approve/reject (per hunk or whole file) against git and keeps an in-memory undo stack. No status map: approved = staged, pending = unstaged, rejected = gone. Undo entries record HEAD and are refused/pruned once HEAD moves
- `sidebar/fileTreeProvider.ts` — VS Code TreeDataProvider for the sidebar; lists files with unstaged changes only, updated per repo (`setRepoFiles`) or per file (`updateFile`); flat list for one repo, one expandable node per repo with changes when several are discovered
- `review/reviewModel.ts` — Pure (no `vscode`) mapping from a `DiffFile` to 0-based editor positions: added spans, CodeLens lines, comment-widget anchors (`newStart-2`, since widgets render below their line and lenses above), clamping for stale diffs, cursor/next/prev lookups, span shifting for dirty buffers. Unit-tested
- `review/reviewModeController.ts` — Owns the review-mode flag, status bar item, decoration types and a per-file render signature; renders/clears visible editors, tracks unsaved edits (dimmed decorations, actions blocked), and exposes `refreshRepos`/`refreshFile` for scoped updates
- `review/removedLinesComments.ts` — One read-only `CommentThread` per hunk with removed lines (no commenting-range provider, no replies, no menus), reconciled by hunk ID
- `review/reviewCodeLensProvider.ts` — Approve/Reject lenses per hunk, file-level lens on line 0, "save to continue" lens while dirty

**Key design decisions:**
- The git index is the approval state. Only `git diff` (index → worktree) plus untracked files are reviewed; anything staged is approved and invisible. Fully staged files leave the sidebar
- Patches for staging come from the index → worktree diff, so their old-side line numbers are index-relative and `git apply --cached --unidiff-zero` lands exactly even when unstaged edits sit above the hunk
- Whole-file handling (`git add`, `checkout-index`, unlink) for untracked, intent-to-add, deleted, binary, mode-only and empty files
- Files are identified by `fileKey(repoRoot, filePath)` everywhere (render cache, CodeLens arguments, undo), since the same relative path can exist in several repos
- Refresh is scoped: an action re-reads and updates only its file; workspace-file and `.git/index`/`HEAD` watcher events re-read only the repository they belong to; repository discovery (slow for large parent folders) runs only at startup, on workspace/setting changes, when a `.git` appears or disappears, and on the Refresh button
- All git mutations and refreshes are serialised through one promise queue in `extension.ts`; actions re-read their file inside the queue before touching git
- Editors skip re-rendering when the diff, line count and dirty flag are unchanged (`renderSignature` in `reviewModel.ts`, cached per file in the controller)
- Review mode is global, in-memory only and off after every window reload; only `git diff` positions on disk are trusted, so a dirty editor blocks approve/reject until saved

## Testing

Tests use `node:test` and `node:assert/strict` (not Jest/Mocha). Test files are in `test/` with `.test.ts` extension, run via tsx loader. Fixtures are in `test/fixtures/`. Git-level tests run against throwaway repositories created by `test/helpers/gitSandbox.ts`, which isolates them from the user's git config.

## Code Style

- Prettier: single quotes, trailing commas, 100 char width, 2-space indent
- ESLint with typescript-eslint, unused vars prefixed with `_`
- Node 22 (see `.nvmrc`)

## Before Every Commit

Before creating any commit, always:

1. **Bump the version in `package.json`** following SemVer:
   - `patch` (x.x.+1) — bug fixes only
   - `minor` (x.+1.0) — new features, backwards-compatible
   - `major` (+1.0.0) — breaking changes
   - Keep the `-rc` / `-beta` pre-release suffix if the release is not yet stable

2. **Update `CHANGELOG.md`** — add a new section at the top for the new version with the release date and a summary of changes under `### Added`, `### Fixed`, and/or `### Changed` headings as appropriate.
