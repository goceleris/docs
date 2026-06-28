import { version, arch, archesForVersion, loadPayload, showToast } from "../state";
import { VersionSelect } from "./VersionSelect";
import { paletteOpen, paletteKbd } from "./CommandPalette";

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

  return (
    <div class="dbar">
      <span class="dbar-label">Release</span>
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
                aria-pressed={arch.value === a}
                aria-disabled={!avail}
              >
                {a}
              </button>
            );
          })}
        </div>
      )}

      <button class="cmdk-trigger" type="button" onClick={() => (paletteOpen.value = true)} aria-label="Open command palette">
        <span class="cmdk-trigger-label">Search</span>
        <kbd>{paletteKbd}</kbd>
      </button>
    </div>
  );
}
