/**
 * The lifecycle tree's editor surface. All the shape decisions live in tree-model.ts; this file only
 * turns nodes into TreeItems and reacts to store changes.
 */
import * as vscode from 'vscode';
import { buildLifecycleTree, type TreeNode } from './tree-model.ts';
import type { RepositorySnapshot } from '../cli/snapshot.ts';
import type { WorkspaceStore } from '../state.ts';

export type TreeBuilder = (snapshot: RepositorySnapshot | null, error?: Error | null) => TreeNode[];

export class LifecycleTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscription: { dispose(): void };
  private readonly store: WorkspaceStore | null;
  private roots: TreeNode[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  /**
   * @param store the workspace, or null when the extension cannot serve it — in which case `roots`
   *   is a fixed explanation. A provider is registered either way: leaving the contributed view
   *   unprovided is what makes VS Code report that no data provider exists, which says nothing
   *   about the repository the reader actually has open.
   */
  constructor(
    store: WorkspaceStore | null,
    roots: TreeNode[] = [],
    private readonly build: TreeBuilder = buildLifecycleTree
  ) {
    this.store = store;
    this.roots = roots;
    if (!store) {
      this.subscription = { dispose() {} };
      return;
    }
    this.subscription = store.onDidChange((state) => {
      this.roots = this.build(state.snapshot, state.error);
      this.emitter.fire(undefined);
    });
    const state = store.current;
    this.roots = this.build(state.snapshot, state.error);
  }

  /** Re-render derived presentation state without re-running the repository snapshot command. */
  refresh(): void {
    if (!this.store) return;
    const state = this.store.current;
    this.roots = this.build(state.snapshot, state.error);
    this.emitter.fire(undefined);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? (node.children ?? []) : this.roots;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible = node.children?.length
      // The lifecycle and the current Epic are the things someone opened the view to see.
      ? (node.kind === 'initiative' || node.id === 'phases' || node.id === 'gate'
          || node.id === 'configuration' || node.id === 'config:capabilities' || node.id === 'unavailable'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    if (node.description) item.description = node.description;
    if (node.tooltip) item.tooltip = node.tooltip;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.contextValue) item.contextValue = node.contextValue;
    if (node.runCommand) {
      item.command = { command: node.runCommand, title: node.label, arguments: [node] };
    } else if (node.path) {
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
