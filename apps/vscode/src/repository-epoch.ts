/** Identity of one repository binding at one moment in a VS Code window. */
export interface RepositoryEpochToken {
  readonly repository: string;
  readonly epoch: number;
}

/**
 * Prevent a late asynchronous answer from an earlier repository binding reaching current UI.
 *
 * Repository path alone is insufficient: a window can move A -> B -> A, and both repositories can
 * contain the same Work ID. Every accepted rebind therefore advances the epoch even when its
 * canonical path equals a path used before.
 */
export class RepositoryEpochGuard {
  private repository: string;
  private epoch = 0;

  constructor(repository: string) { this.repository = repository; }

  capture(): RepositoryEpochToken {
    return { repository: this.repository, epoch: this.epoch };
  }

  moved(repository: string): void {
    this.repository = repository;
    this.epoch += 1;
  }

  isCurrent(token: RepositoryEpochToken): boolean {
    return token.repository === this.repository && token.epoch === this.epoch;
  }
}
