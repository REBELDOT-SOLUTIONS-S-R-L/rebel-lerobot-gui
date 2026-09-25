import type { Demo, DemoDraft } from '@shared/demos'
import { emptyDemo } from '@shared/demos'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AddDemoCard, DemoCard } from '../components/DemoCard'
import { DemoFormModal } from '../components/DemoFormModal'
import { DemoRunModal } from '../components/DemoRunModal'
import { EmptyState } from '../components/ui'
import { useAppStore } from '../store/useAppStore'

/**
 * The Demos grid.
 *
 * Unlike the workflow panels, this one has no side column: a demo is a saved
 * script rather than a form to fill in, so the tab is a library and everything
 * that acts on one demo happens in a dialog over it.
 *
 * Exactly one dialog is open at a time, which is what `view` encodes. Editing
 * from inside the run dialog swaps one for the other rather than stacking them.
 */
type View =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'run'; uid: string }
  | { kind: 'edit'; uid: string }

export function DemosPanel(): ReactNode {
  const { demos, demoRuns, profiles, runs, saveDemo, removeDemo, startDemo } = useAppStore(
    useShallow((s) => ({
      demos: s.demos,
      demoRuns: s.demoRuns,
      profiles: s.profiles,
      runs: s.runs,
      saveDemo: s.saveDemo,
      removeDemo: s.removeDemo,
      startDemo: s.startDemo
    }))
  )

  const [view, setView] = useState<View>({ kind: 'none' })
  // Held separately from `view` so a cancelled create keeps the same uid — the
  // thumbnail it may already have copied in is filed under that uid.
  const [draft, setDraft] = useState<DemoDraft>(() => emptyDemo())

  const runFor = useMemo(() => {
    const byId = new Map(runs.map((r) => [r.runId, r]))
    return (uid: string) => byId.get(demoRuns[uid] ?? '') ?? null
  }, [runs, demoRuns])

  const openDemo = view.kind === 'run' || view.kind === 'edit'
    ? (demos.find((d) => d.uid === view.uid) ?? null)
    : null

  // A demo can be deleted from inside its own edit dialog, and the delete is
  // what clears `openDemo`. Fall back to the grid rather than leaving a dialog
  // bound to a demo that is no longer there.
  const orphaned = (view.kind === 'run' || view.kind === 'edit') && !openDemo
  useEffect(() => {
    if (orphaned) setView({ kind: 'none' })
  }, [orphaned])

  const startCreate = (): void => {
    setDraft(emptyDemo())
    setView({ kind: 'create' })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Demos</h2>
          <p className="text-xs text-ink-600">
            Saved scripts, run in this machine&rsquo;s shell with the venv on PATH.
          </p>
        </div>
        {demos.length > 0 && (
          <span className="text-xs text-ink-600">
            {demos.length} demo{demos.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {demos.length === 0 ? (
          <EmptyState title="No demos yet">
            A demo is a shell script with a name, the devices it needs, and a picture. Add one and
            it gets a card here that runs it.
            <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
              <AddDemoCard onClick={startCreate} />
            </div>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3 pb-2">
            {demos.map((demo) => (
              <DemoCard
                key={demo.uid}
                demo={demo}
                devices={profiles}
                status={runFor(demo.uid)?.status ?? null}
                onOpen={() => setView({ kind: 'run', uid: demo.uid })}
              />
            ))}
            <AddDemoCard onClick={startCreate} />
          </div>
        )}
      </div>

      {view.kind === 'create' && (
        <DemoFormModal
          initial={draft}
          devices={profiles}
          others={demos}
          onSave={saveDemo}
          onClose={() => setView({ kind: 'none' })}
        />
      )}

      {view.kind === 'run' && openDemo && (
        <DemoRunModal
          demo={openDemo}
          devices={profiles}
          run={runFor(openDemo.uid)}
          onStart={() => startDemo(openDemo.uid)}
          onEdit={() => setView({ kind: 'edit', uid: openDemo.uid })}
          onClose={() => setView({ kind: 'none' })}
        />
      )}

      {view.kind === 'edit' && openDemo && (
        <DemoFormModal
          initial={toDraft(openDemo)}
          devices={profiles}
          others={demos}
          onSave={saveDemo}
          onDelete={() => removeDemo(openDemo.uid)}
          // Back to the run dialog rather than to the grid: editing was reached
          // from there, so that is where cancelling belongs.
          onClose={() => setView({ kind: 'run', uid: openDemo.uid })}
        />
      )}

    </div>
  )
}

function toDraft(demo: Demo): DemoDraft {
  const { createdAt: _c, updatedAt: _u, ...draft } = demo
  return draft
}
