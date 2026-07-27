/**
 * Snapshot-based undo/redo. The project model is small (a few KB of JSON),
 * so full-state snapshots are simpler and more reliable than command
 * inversion, and they automatically cover every kind of edit: point moves,
 * subdivisions, post add/remove, parameter changes.
 *
 * Gesture semantics: callers push ONE snapshot at the start of a drag
 * gesture (pointerdown) so an entire drag undoes as a unit.
 */
export class UndoStack {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  /** Record the state as it was BEFORE the mutation about to happen. */
  push(snapshot: string): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top === snapshot) return; // no-op edits don't pollute history
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Returns the snapshot to restore, given the current state for redo. */
  undo(current: string): string | null {
    const snap = this.undoStack.pop();
    if (snap === undefined) return null;
    this.redoStack.push(current);
    return snap;
  }

  redo(current: string): string | null {
    const snap = this.redoStack.pop();
    if (snap === undefined) return null;
    this.undoStack.push(current);
    return snap;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
