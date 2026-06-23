import { useEffect, useRef, useState } from "preact/hooks";
import { version, versionsList, archesForVersion, arch, loadPayload } from "../state";
import { Check } from "./Icons";

/** Custom version dropdown — premium, themed, keyboard- and click-outside-aware. */
export function VersionSelect() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const versions = versionsList.value;

  function toggle() {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, width: r.width });
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(v: string) {
    setOpen(false);
    if (v === version.value) return;
    version.value = v;
    if (!archesForVersion.value.includes(arch.value)) {
      arch.value = archesForVersion.value[0] ?? arch.value;
    }
    void loadPayload(version.value, arch.value);
  }

  if (!versions.length) return null;

  return (
    <div class={`vsel${open ? " open" : ""}`} ref={ref}>
      <button
        type="button"
        class="vsel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span class="vsel-cur">{version.value}</span>
        <svg class="vsel-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul
          class="vsel-menu scroll-thin"
          role="listbox"
          aria-label="Version"
          style={{ top: `${pos.top}px`, left: `${pos.left}px`, minWidth: `${pos.width}px` }}
        >
          {versions.map((v) => {
            const sel = v === version.value;
            return (
              <li
                role="option"
                aria-selected={sel}
                class={`vsel-opt${sel ? " sel" : ""}`}
                onClick={() => pick(v)}
              >
                <span class="vsel-check">{sel && <Check s={12} />}</span>
                {v}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
