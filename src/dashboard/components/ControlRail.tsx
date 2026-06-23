import { payload, scenario, adapters, toggleAdapter, setAdapters } from "../state";
import { SCENARIOS, COMPETITORS, adapterShort, isCeleris, celerisIds, CURATED_RIVALS } from "../registry";
import type { ScenarioCategory } from "@results/types";
import { Check } from "./Icons";

export function ControlRail() {
  const p = payload.value;
  if (!p) return <aside class="rail" />;

  // Group scenarios by category, ordered.
  const scns = p.headline.scenarios;
  const groups = new Map<string, string[]>();
  for (const id of scns) {
    const cat = SCENARIOS.scenarios[id]?.category ?? "static";
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(id);
  }
  const orderedCats = [...groups.keys()].sort(
    (a, b) =>
      (SCENARIOS.categories[a as ScenarioCategory]?.order ?? 99) -
      (SCENARIOS.categories[b as ScenarioCategory]?.order ?? 99),
  );

  // Adapters present in this payload, celeris first then alphabetical.
  const present = Object.keys(p.servers);
  present.sort((a, b) => {
    const ca = isCeleris(a) ? 0 : 1;
    const cb = isCeleris(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.localeCompare(b);
  });

  const sel = new Set(adapters.value);

  return (
    <aside class="rail scroll-thin">
      <div>
        <h3>Scenario</h3>
        {orderedCats.map((cat) => {
          const items = groups.get(cat)!;
          const open = items.includes(scenario.value);
          return (
            <details class="scn-group" open={open}>
              <summary>
                {SCENARIOS.categories[cat as ScenarioCategory]?.display ?? cat}{" "}
                <span class="count">({items.length})</span>
              </summary>
              {items.map((id) => (
                <button
                  class={`scn-item${scenario.value === id ? " active" : ""}`}
                  onClick={() => (scenario.value = id)}
                >
                  {SCENARIOS.scenarios[id]?.display_name ?? id}
                </button>
              ))}
            </details>
          );
        })}
      </div>

      <div>
        <h3>Adapters ({sel.size})</h3>
        <div class="rail-actions">
          <button class="mini-btn" onClick={() => setAdapters(present)}>All</button>
          <button class="mini-btn" onClick={() => setAdapters(celerisIds())}>Only Celeris</button>
          <button
            class="mini-btn"
            onClick={() => setAdapters([...celerisIds(), ...CURATED_RIVALS.filter((r) => present.includes(r))])}
          >
            Curated
          </button>
        </div>
        <div class="adapter-list scroll-thin">
          {present.map((id) => {
            const on = sel.has(id);
            const cel = isCeleris(id);
            return (
              <button
                class={`adapter-item${on ? " on" : ""}${cel ? " celeris" : ""}`}
                onClick={() => toggleAdapter(id)}
                aria-pressed={on}
              >
                <span class="swatch" style={{ background: COMPETITORS.adapters[id]?.color ?? "#888" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {adapterShort(id)}
                </span>
                {on && <Check s={12} style={{ marginLeft: "auto", color: "var(--accent)", flex: "none" }} />}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
