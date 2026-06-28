import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import {
  VIEWS,
  SCENARIO_VIEWS,
  view,
  version,
  arch,
  scenario,
  scenarios,
  versionsList,
  archesForVersion,
  payload,
  setAdapters,
  loadPayload,
  showToast,
  type ViewId,
} from "../state";
import { SCENARIOS, scenarioName, scenarioMeta, celerisIds, CURATED_RIVALS, COMPETITORS } from "../registry";

/** Open/close state for the ⌘K palette (also togglable from the Topbar trigger). */
export const paletteOpen = signal(false);

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
export const paletteKbd = isMac ? "⌘K" : "Ctrl K";

function toggleTheme() {
  const el = document.documentElement;
  const next = el.getAttribute("data-theme") === "light" ? "dark" : "light";
  el.setAttribute("data-theme", next);
  try {
    localStorage.setItem("celeris-theme", next);
  } catch {
    /* ignore */
  }
}

/** Build the command list from current dashboard state (reactive — reads signals). */
function buildCommands(): Cmd[] {
  const cmds: Cmd[] = [];
  const present = payload.value ? Object.keys(payload.value.servers) : [];

  for (const v of VIEWS) {
    cmds.push({ id: `view:${v.id}`, group: "View", label: v.label, run: () => (view.value = v.id as ViewId) });
  }

  for (const s of scenarios.value) {
    const cat = scenarioMeta(s) ? SCENARIOS.categories[scenarioMeta(s)!.category]?.display ?? "" : "";
    cmds.push({
      id: `scn:${s}`,
      group: "Scenario",
      label: scenarioName(s),
      hint: cat,
      run: () => {
        scenario.value = s;
        if (!SCENARIO_VIEWS.includes(view.value)) view.value = "leaderboard";
      },
    });
  }

  cmds.push({ id: "adp:all", group: "Adapters", label: "All adapters", run: () => setAdapters(present) });
  cmds.push({ id: "adp:celeris", group: "Adapters", label: "Only Celeris", run: () => setAdapters(celerisIds()) });
  cmds.push({
    id: "adp:go",
    group: "Adapters",
    label: "Only Go",
    run: () => setAdapters(present.filter((id) => COMPETITORS.adapters[id]?.language === "go")),
  });
  cmds.push({
    id: "adp:curated",
    group: "Adapters",
    label: "Curated set",
    run: () =>
      setAdapters([
        ...celerisIds().filter((id) => id !== "celeris-std-h1"),
        ...CURATED_RIVALS.filter((r) => present.includes(r)),
      ]),
  });

  for (const v of versionsList.value) {
    if (v.version === version.value) continue;
    cmds.push({
      id: `ver:${v.version}`,
      group: "Version",
      label: v.version,
      run: () => {
        version.value = v.version;
        if (!archesForVersion.value.includes(arch.value)) arch.value = archesForVersion.value[0] ?? arch.value;
        void loadPayload(version.value, arch.value);
      },
    });
  }

  for (const a of ["x86_64", "arm64"]) {
    if (a === arch.value) continue;
    const avail = archesForVersion.value.includes(a);
    cmds.push({
      id: `arch:${a}`,
      group: "Arch",
      label: a,
      hint: avail ? undefined : "soon",
      run: () => {
        if (!avail) {
          showToast(`${a} benchmarks are coming soon`);
          return;
        }
        arch.value = a;
        void loadPayload(version.value, a);
      },
    });
  }

  cmds.push({ id: "theme", group: "Theme", label: "Toggle light / dark", run: toggleTheme });
  cmds.push({ id: "nav:docs", group: "Go to", label: "Documentation", run: () => (location.href = "/docs") });
  cmds.push({ id: "nav:method", group: "Go to", label: "Methodology", run: () => (location.href = "/methodology") });
  cmds.push({ id: "nav:home", group: "Go to", label: "Home", run: () => (location.href = "/") });

  return cmds;
}

function match(cmds: Cmd[], q: string): Cmd[] {
  const s = q.trim().toLowerCase();
  if (!s) return cmds;
  const toks = s.split(/\s+/);
  return cmds.filter((c) => {
    const hay = `${c.group} ${c.label} ${c.hint ?? ""}`.toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

export function CommandPalette() {
  const open = paletteOpen.value;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<Element | null>(null);

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Focus management: focus the input on open, restore focus on close.
  useEffect(() => {
    if (open) {
      lastFocus.current = document.activeElement;
      setQ("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (lastFocus.current instanceof HTMLElement) {
      lastFocus.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const filtered = match(buildCommands(), q);
  const cur = Math.min(sel, Math.max(0, filtered.length - 1));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = filtered[cur];
      if (c) {
        paletteOpen.value = false;
        c.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      paletteOpen.value = false;
    }
  };

  return (
    <div class="cmdk-overlay" onClick={() => (paletteOpen.value = false)}>
      <div class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="cmdk-input"
          type="text"
          placeholder="Jump to a view, scenario, adapter set…"
          aria-label="Command"
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul class="cmdk-list scroll-thin" role="listbox" aria-label="Commands">
          {filtered.length === 0 && <li class="cmdk-empty">No matches</li>}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === cur}
              class={`cmdk-item${i === cur ? " sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                paletteOpen.value = false;
                c.run();
              }}
            >
              <span class="cmdk-group">{c.group}</span>
              <span class="cmdk-label">{c.label}</span>
              {c.hint && <span class="cmdk-hint">{c.hint}</span>}
            </li>
          ))}
        </ul>
        <div class="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
