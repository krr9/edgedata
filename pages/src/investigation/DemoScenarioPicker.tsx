import { useCallback, useEffect, useState } from 'react';
import type { InvestigationPivots, PivotKey } from './types';

export interface DemoScenario {
  id: string;
  label: string;
  scope: { index: string; service: string; env: string };
  time: { from: string; to: string };
  pivot_chips: Array<{ key: string; value: string }>;
  starter_queries: Array<{ id: string; title: string; ppl: string }>;
}

export interface DemoScenarioSelection {
  scope: { index: string; service: string; env: string };
  time: { from: string; to: string };
  pivots: InvestigationPivots;
  starterQueries: Array<{ id: string; title: string; ppl: string }>;
}

interface DemoScenarioPickerProps {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onSelectScenario: (selection: DemoScenarioSelection) => void;
}

export function DemoScenarioPicker({ apiFetch, onSelectScenario }: DemoScenarioPickerProps) {
  const [scenarios, setScenarios] = useState<DemoScenario[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    async function fetchScenarios() {
      setLoading(true);
      try {
        const response = await apiFetch('/investigations/demo-scenarios');
        const body = (await response.json()) as {
          demo_mode?: boolean;
          scenarios?: DemoScenario[];
          error?: string;
        };
        if (!response.ok || body.error) {
          setScenarios([]);
          setDemoMode(false);
          return;
        }
        if (!cancelled) {
          setDemoMode(body.demo_mode === true);
          setScenarios(Array.isArray(body.scenarios) ? body.scenarios : []);
        }
      } catch {
        if (!cancelled) {
          setScenarios([]);
          setDemoMode(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchScenarios();
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setSelectedId(id);
      const scenario = scenarios.find((s) => s.id === id);
      if (!scenario) return;
      const pivots: InvestigationPivots = {};
      for (const c of scenario.pivot_chips || []) {
        if (c.key && c.value) pivots[c.key as PivotKey] = c.value;
      }
      onSelectScenario({
        scope: scenario.scope,
        time: scenario.time,
        pivots,
        starterQueries: scenario.starter_queries || []
      });
    },
    [scenarios, onSelectScenario]
  );

  if (!demoMode || scenarios.length === 0) {
    return null;
  }

  if (loading) {
    return (
      <div className="demo-scenario-picker">
        <span className="demo-scenario-picker-loading">Loading scenarios…</span>
      </div>
    );
  }

  return (
    <div className="demo-scenario-picker">
      <label htmlFor="demo-scenario-select">
        <span className="demo-scenario-picker-label">Demo scenario:</span>
      </label>
      <select
        id="demo-scenario-select"
        className="demo-scenario-picker-select"
        value={selectedId}
        onChange={handleChange}
      >
        <option value="">— Select a scenario —</option>
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
