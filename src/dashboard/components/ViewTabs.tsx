import type { ViewId } from "../state";
import { view, viewLabel, SCENARIO_VIEWS, OVERVIEW_VIEWS } from "../state";

function Tab({ id }: { id: ViewId }) {
  const active = view.value === id;
  return (
    <button
      role="tab"
      aria-selected={active}
      class={`tab${active ? " active" : ""}`}
      onClick={() => (view.value = id)}
    >
      {viewLabel(id)}
    </button>
  );
}

export function ViewTabs() {
  return (
    <div class="tabs" role="tablist" aria-label="Dashboard views">
      <span class="tab-grouplabel">Scenario</span>
      {SCENARIO_VIEWS.map((id) => (
        <Tab id={id} />
      ))}
      <span class="tab-sep" aria-hidden="true" />
      <span class="tab-grouplabel">Overview</span>
      {OVERVIEW_VIEWS.map((id) => (
        <Tab id={id} />
      ))}
    </div>
  );
}
