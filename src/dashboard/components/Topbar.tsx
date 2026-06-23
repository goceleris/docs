import { version, arch, archesForVersion, loadPayload, showToast } from "../state";
import { Sun, Moon } from "./Icons";
import { VersionSelect } from "./VersionSelect";

export function Topbar() {
  const arches = archesForVersion.value;

  function onArch(a: string) {
    if (a === arch.value) return;
    if (!archesForVersion.value.includes(a)) {
      showToast(`${a} benchmarks are coming soon`);
      return;
    }
    arch.value = a;
    void loadPayload(version.value, arch.value);
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("celeris-theme", next);
    } catch {}
  }

  return (
    <div class="dbar">
      <a class="brand" href="/" aria-label="Celeris home">
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--surface-3)" stroke="var(--border-strong)" />
          <g stroke="var(--accent)" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 10 L15 16 L9 22" opacity="0.45" />
            <path d="M14 10 L20 16 L14 22" opacity="0.72" />
            <path d="M19 10 L25 16 L19 22" />
          </g>
        </svg>
        <span>celeris</span>
        <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>benchmarks</span>
      </a>

      <VersionSelect />

      {arches.length > 0 && (
        <div class="seg" role="group" aria-label="Architecture">
          {["x86_64", "arm64"].map((a) => {
            const avail = arches.includes(a);
            return (
              <button
                class={`${arch.value === a ? "active " : ""}${avail ? "" : "unavail"}`.trim()}
                onClick={() => onArch(a)}
                title={avail ? a : `${a} benchmarks coming soon`}
              >
                {a}
              </button>
            );
          })}
        </div>
      )}

      <span class="spacer" />
      <a class="meta-link" href="/methodology">Methodology</a>
      <button class="theme-ico" onClick={toggleTheme} aria-label="Toggle theme">
        <Sun s={16} class="i-sun" />
        <Moon s={16} class="i-moon" />
      </button>
      <a class="meta-link" href="https://github.com/goceleris/celeris" target="_blank" rel="noopener">GitHub</a>
    </div>
  );
}
