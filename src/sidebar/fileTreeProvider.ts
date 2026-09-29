import * as path from 'path';
import * as vscode from 'vscode';
import { RepoInfo, RepoManager } from '../git/repoManager';
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

  constructor(private repos: RepoManager) {}

  /** Re-discover repositories and reload the aggregated diff. */
  async refresh(): Promise<void> {
    const repos = await this.repos.discover();
    this.files = await this.repos.getDiff();

    const byRoot = new Map<string, DiffFile[]>();
    for (const file of this.files) {
      const list = byRoot.get(file.repoRoot);
      if (list) {
        list.push(file);
      } else {
        byRoot.set(file.repoRoot, [file]);
      }
    }
    this.repoNodes = repos.map((repo) => ({
      kind: 'repo',
      repo,
      files: byRoot.get(repo.root) ?? [],
    }));

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
