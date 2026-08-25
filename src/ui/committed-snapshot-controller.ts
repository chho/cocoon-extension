export type SnapshotMutation<Snapshot> = (
  snapshot: Snapshot,
  invalidatePendingRefresh: () => void,
) => void;

export interface CommittedSnapshotController<Snapshot> {
  beginMutation(): SnapshotMutation<Snapshot>;
  noteRevision(): void;
  applyRefresh(snapshot: Snapshot): void;
}

export function createCommittedSnapshotController<Snapshot>(
  apply: (snapshot: Snapshot) => void,
  reconcile: () => Promise<Snapshot | null>,
): CommittedSnapshotController<Snapshot> {
  let revisionSequence = 0;
  let reconciliationSequence = 0;

  function scheduleReconciliation(): void {
    const sequence = ++reconciliationSequence;
    void (async () => {
      try {
        const snapshot = await reconcile();
        if (snapshot !== null && sequence === reconciliationSequence) apply(snapshot);
      } catch {
        // A failed reconciliation never invalidates an already committed snapshot.
      }
    })();
  }

  return {
    beginMutation() {
      const revisionAtStart = revisionSequence;
      return (snapshot, invalidatePendingRefresh) => {
        invalidatePendingRefresh();
        apply(snapshot);
        if (revisionSequence > revisionAtStart) scheduleReconciliation();
      };
    },
    noteRevision() {
      revisionSequence += 1;
      reconciliationSequence += 1;
    },
    applyRefresh(snapshot) {
      apply(snapshot);
    },
  };
}
