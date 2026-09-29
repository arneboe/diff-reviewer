# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension for interactive diff review. Built for reviewing what a coding agent wrote. It shows unstaged changes (index → working tree) and untracked files from every git repository in the workspace in a sidebar file tree and opens per-file webview panels where users can approve or reject individual hunks. Approving stages the hunk via `git apply --cached`; rejecting reverse-applies it on disk via `git apply -R`. The git index is the approval state. Actions are undoable for the session.

## Commands

- `npm run build` — Bundle extension + webview with esbuild (output in `out/`)
- `npm run watch` — Watch mode for development
- `npm test` — Run tests (uses Node.js built-in test runner with tsx; needs Node ≥ 20, run `nvm use 24` first if the system node is older)
- `npm run lint` — ESLint + TypeScript type check (`tsc --noEmit`)
- `npm run lint:fix` — Auto-fix ESLint issues
- `npm run ts:check` — Type check only
- Run a single test file: `node --import tsx --test test/diffParser.test.ts`

Pre-commit hook runs `npm run lint:fix && npm run ts:check`.

## Architecture

**Two build targets** (see `esbuild.mjs`):
1. **Extension** (`src/extension.ts` → `out/extension.js`): Node/CommonJS, externals `vscode`
2. **Webview** (`media/webview.js` → `out/webview.js`): Browser/IIFE

**Extension-side modules** (`src/`):
- `extension.ts` — Activation, command registration, message routing between webview and state
- `git/repoDiscovery.ts` — Finds git repositories for the workspace folders: a folder inside a work tree yields that repo; otherwise subfolders are scanned (depth from `diffReviewer.repoScanDepth`)
- `git/repoManager.ts` — One `GitAdapter` per discovered repo; aggregates `getDiff()` across repos, reports per-repo HEAD / staged state / git dir, and resolves the adapter for a `repoRoot`
- `git/gitAdapter.ts` — Shells out to `git` CLI within a single repo: unstaged diff (`git diff`, no `HEAD`), untracked files, `git apply` (worktree and `--cached`, forward/reverse), `git add`, index-entry read/restore (incl. intent-to-add), `checkout-index`; stamps `repoRoot` on every `DiffFile`
- `git/diffParser.ts` — Parses unified diff text into `DiffFile`/`DiffHunk` structures (paths from the `diff --git` line, file kind, mode changes, no-newline markers), then `splitHunks()` breaks each hunk into granular sub-hunks (one per contiguous change group). `buildPatch()` turns one sub-hunk into a `git apply --unidiff-zero` patch. Content-based hunk IDs (FNV-1a) let the webview address a hunk safely
- `state/stateManager.ts` — Executes approve/reject (per hunk or whole file) against git and keeps an in-memory undo stack. No status map: approved = staged, pending = unstaged, rejected = gone. Undo entries record HEAD and are refused/pruned once HEAD moves
- `sidebar/fileTreeProvider.ts` — VS Code TreeDataProvider for the sidebar; lists files with unstaged changes only; flat list for one repo, one expandable node per repo with changes when several are discovered
- `webview/diffPanelProvider.ts` — Creates/manages webview panels, handles message passing
- `highlighter.ts` — Server-side syntax highlighting via highlight.js, splits highlighted HTML across line boundaries

**Webview-side** (`media/`):
- `webview.js` — Renders the working-tree file with pending hunks inline (not a side-by-side diff); staged changes are plain lines. Handles approve/reject via `postMessage`; every action triggers a full re-render from the extension
- `webview.css` — Styling with VS Code CSS variable integration, light/dark theme support

**Key design decisions:**
- The git index is the approval state. Only `git diff` (index → worktree) plus untracked files are reviewed; anything staged is approved and invisible. Fully staged files leave the sidebar
- Patches for staging come from the index → worktree diff, so their old-side line numbers are index-relative and `git apply --cached --unidiff-zero` lands exactly even when unstaged edits sit above the hunk
- Whole-file handling (`git add`, `checkout-index`, unlink) for untracked, intent-to-add, deleted, binary, mode-only and empty files
- Files are identified by `fileKey(repoRoot, filePath)` everywhere (panels, webview messages, undo), since the same relative path can exist in several repos
- Every action re-reads the file diff; `.git/index` and `HEAD` are watched so terminal `git add`/`reset`/`commit` refresh the UI

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
