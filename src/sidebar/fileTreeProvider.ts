import * as path from 'path';
import * as vscode from 'vscode';
import { RepoInfo } from '../git/repoManager';
import { DiffFile, diffFilePath } from '../types';

/** Group node shown when more than one repository is present. */
export interface RepoNode {
  kind: 'repo';
  repo: RepoInfo;
  files: DiffFile[];
}

export type TreeNode = RepoNode | DiffFile;

function isRepoNode(node: TreeNode): node is RepoNode {
  return (node as RepoNode).kind === 'repo';
}

export class FileTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: DiffFile[] = [];
  private repoNodes: RepoNode[] = [];

  /** Changed files per repository root, kept across partial updates. */
  private filesByRoot = new Map<string, DiffFile[]>();

  /** Set the discovered repositories; files of repositories that remain are kept. */
  setRepos(repos: RepoInfo[]): void {
    const roots = new Set(repos.map((r) => r.root));
    for (const root of [...this.filesByRoot.keys()]) {
      if (!roots.has(root)) {
        this.filesByRoot.delete(root);
      }
    }
    this.repoNodes = repos.map((repo) => ({ kind: 'repo', repo, files: [] }));
    this.rebuild();
  }

  /** Replace every file of one repository. */
  setRepoFiles(repoRoot: string, files: DiffFile[]): void {
    this.filesByRoot.set(repoRoot, files);
    this.rebuild();
  }

  /**
   * Replace one file after an action, or remove it when it has nothing left
   * to review. A file not yet listed is appended to its repository.
   */
  updateFile(repoRoot: string, filePath: string, file: DiffFile | null): void {
    const list = [...(this.filesByRoot.get(repoRoot) ?? [])];
    const idx = list.findIndex((f) => diffFilePath(f) === filePath);
    if (file && idx >= 0) {
      list[idx] = file;
    } else if (file) {
      list.push(file);
    } else if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      return;
    }
    this.filesByRoot.set(repoRoot, list);
    this.rebuild();
  }

  private rebuild(): void {
    for (const node of this.repoNodes) {
      node.files = this.filesByRoot.get(node.repo.root) ?? [];
    }
    this.files = this.repoNodes.flatMap((n) => n.files);
    this._onDidChangeTreeData.fire(undefined);
  }

  getFiles(): DiffFile[] {
    return this.files;
  }

  getRepoCount(): number {
    return this.repoNodes.length;
  }

  findFile(repoRoot: string, filePath: string): DiffFile | undefined {
    return this.files.find((f) => f.repoRoot === repoRoot && diffFilePath(f) === filePath);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isRepoNode(element)) {
      return this.getRepoItem(element);
    }
    return this.getFileItem(element);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) {
      return isRepoNode(element) ? element.files : [];
    }
    // A single repository keeps the flat list; several get one group each.
    // Repositories without changes are hidden.
    if (this.repoNodes.length <= 1) {
      return this.files;
    }
    return this.repoNodes.filter((node) => node.files.length > 0);
  }

  private getRepoItem(node: RepoNode): vscode.TreeItem {
    const count = node.files.length;

    const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
    const location =
      node.repo.relativePath && node.repo.relativePath !== node.repo.name
        ? node.repo.relativePath
        : '';
    const summary = `${count} file${count === 1 ? '' : 's'} to review`;
    item.description = location ? `${location}  ·  ${summary}` : summary;
    item.tooltip = node.repo.root;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.contextValue = 'diffRepo';
    item.id = `repo:${node.repo.root}`;
    return item;
  }

  private getFileItem(element: DiffFile): vscode.TreeItem {
    const filePath = diffFilePath(element);
    const fileName = path.basename(filePath);
    const dirPath = path.dirname(filePath);
    // Zero-hunk files (binary, mode-only, empty) still count as one change.
    const pendingCount = Math.max(1, element.hunks.length + (element.modeChange ? 1 : 0));
    const badge = pendingCount > 99 ? '99+' : String(pendingCount);

    const label: vscode.TreeItemLabel = {
      label: ` (${badge})  ${fileName}`,
      highlights: [[0, badge.length + 4]],
    };
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = dirPath === '.' ? '' : dirPath + '/';
    item.contextValue = 'diffFile';
    item.id = `file:${element.repoRoot}:${filePath}`;
    if (element.kind === 'added') {
      item.iconPath = new vscode.ThemeIcon('new-file');
    } else if (element.kind === 'deleted') {
      item.iconPath = new vscode.ThemeIcon('diff-removed');
    } else if (element.isBinary) {
      item.iconPath = new vscode.ThemeIcon('file-binary');
    }
    item.command = {
      command: 'diffReviewer.openFile',
      title: 'Open Diff View',
      arguments: [element],
    };
    return item;
  }
}
