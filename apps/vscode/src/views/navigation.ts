/**
 * The editor surface for the two navigation trees. All shape decisions live in navigation-trees.ts;
 * this only turns nodes into TreeItems and reacts to what changes underneath them.
 */
import * as vscode from 'vscode';
import type { TreeNode } from './tree-model.ts';

export class NodeTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private roots: TreeNode[];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(roots: TreeNode[] = []) {
    this.roots = roots;
  }

  /** Replace what the tree shows. A provider is registered even when there is nothing to show. */
  replace(roots: TreeNode[]): void {
    this.roots = roots;
    this.emitter.fire(undefined);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? (node.children ?? []) : this.roots;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children?.length
        // A capability tree is read top-down and is usually shallow; a workspace's contents are
        // detail you open when you want them.
        ? (node.kind === 'group' && node.id.startsWith('capability:')
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = node.id;
    if (node.description) item.description = node.description;
    if (node.tooltip) item.tooltip = node.tooltip;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.contextValue) item.contextValue = node.contextValue;
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
