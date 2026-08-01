/**
 * The lifecycle tree's editor surface. All the shape decisions live in tree-model.ts; this file only
 * turns nodes into TreeItems and reacts to store changes.
 */
import * as vscode from 'vscode';
import { buildTree, type TreeNode } from './tree-model.ts';
import type { WorkspaceStore } from '../state.ts';

export class LifecycleTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly store: WorkspaceStore;
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscription: { dispose(): void };
  private roots: TreeNode[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(store: WorkspaceStore) {
    this.store = store;
    this.subscription = store.onDidChange((state) => {
      this.roots = buildTree(state.snapshot, state.error);
      this.emitter.fire(undefined);
    });
    const state = store.current;
    this.roots = buildTree(state.snapshot, state.error);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? (node.children ?? []) : this.roots;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible = node.children?.length
      // The lifecycle and the current Epic are the things someone opened the view to see.
      ? (node.kind === 'initiative' || node.id === 'phases' || node.id === 'gate'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    if (node.description) item.description = node.description;
    if (node.tooltip) item.tooltip = node.tooltip;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.contextValue) item.contextValue = node.contextValue;
    if (node.path) {
      item.command = {
        command: 'singularityFlow.openArtifact',
        title: 'Open artifact',
        arguments: [node]
      };
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
