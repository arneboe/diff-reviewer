import * as path from 'path';
import * as vscode from 'vscode';
import { RepoInfo, RepoManager } from '../git/repoManager';
import { StateManager } from '../state/stateManager';
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

  constructor(
    private repos: RepoManager,
    private stateManager: StateManager,
  ) {}

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
    const pendingFiles = node.files.filter(
      (f) => !this.stateManager.isFileResolved(f.repoRoot, diffFilePath(f)),
    ).length;

    const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
    const location =
      node.repo.relativePath && node.repo.relativePath !== node.repo.name
        ? node.repo.relativePath
        : '';
    const summary = `${count} file${count === 1 ? '' : 's'}, ${pendingFiles} pending`;
    item.description = location ? `${location}  ·  ${summary}` : summary;
    item.tooltip = node.repo.root;
    item.iconPath =
      pendingFiles === 0
        ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('repo');
    item.contextValue = 'diffRepo';
    item.id = `repo:${node.repo.root}`;
    return item;
  }

  private getFileItem(element: DiffFile): vscode.TreeItem {
    const filePath = diffFilePath(element);
    const fileName = path.basename(filePath);
    const dirPath = path.dirname(filePath);
    const resolved = this.stateManager.isFileResolved(element.repoRoot, filePath);

    if (resolved) {
      const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
      item.description = dirPath === '.' ? '' : dirPath + '/';
      item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      item.contextValue = 'diffFileResolved';
      item.id = `file:${element.repoRoot}:${filePath}`;
      item.command = {
        command: 'diffReviewer.openFile',
        title: 'Open Diff View',
        arguments: [element],
      };
      return item;
    }

    const statuses = this.stateManager.syncStatuses(element);
    const pendingCount = statuses.filter((s) => s === 'pending').length;
    const badge = pendingCount > 99 ? '99+' : String(pendingCount);

    const label: vscode.TreeItemLabel = {
      label: ` (${badge})  ${fileName}`,
      highlights: [[0, badge.length + 4]],
    };
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = dirPath === '.' ? '' : dirPath + '/';
    item.contextValue = 'diffFile';
    item.id = `file:${element.repoRoot}:${filePath}`;
    if (element.isUntracked) {
      item.iconPath = new vscode.ThemeIcon('new-file');
    }
    item.command = {
      command: 'diffReviewer.openFile',
      title: 'Open Diff View',
      arguments: [element],
    };
    return item;
  }
}
