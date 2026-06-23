import { useEffect } from "preact/hooks";
import "./dashboard.css";
import {
  hasData,
  version,
  arch,
  view,
  payload,
  loading,
  loadError,
  versionsList,
  archesForVersion,
  loadPayload,
  startUrlSync,
  toast,
} from "./state";
import { MANIFEST } from "./registry";
import { Topbar } from "./components/Topbar";
import { HeadlineStrip } from "./components/HeadlineStrip";
import { ControlRail } from "./components/ControlRail";
import { ViewTabs } from "./components/ViewTabs";
import { Leaderboard } from "./views/Leaderboard";
import { Latency } from "./views/Latency";
import { OverTime } from "./views/OverTime";
import { Resources } from "./views/Resources";
import { Matrix } from "./views/Matrix";
import { Versions } from "./views/Versions";
import { HeadToHead } from "./views/HeadToHead";

export default function Dashboard() {
  useEffect(() => {
    if (!hasData) return;
    startUrlSync();
    // Repair a stale deep-link before first fetch.
    if (!versionsList.value.includes(version.value)) {
      version.value = MANIFEST.default?.version ?? versionsList.value[0] ?? "";
    }
    if (!archesForVersion.value.includes(arch.value)) {
      arch.value = archesForVersion.value[0] ?? arch.value;
    }
    void loadPayload(version.value, arch.value);
  }, []);

  if (!hasData) return <NoData />;

  return (
    <div class="dash">
      <div class="dtop">
        <Topbar />
        <HeadlineStrip />
      </div>
      <div class="dash-body">
        <ControlRail />
        <main class="dash-main">
          <ViewTabs />
          <div class="view-area scroll-thin">
            <ViewArea />
          </div>
        </main>
      </div>
      {toast.value && <div class="toast" role="status">{toast.value}</div>}
    </div>
  );
}

function ViewArea() {
  if (loading.value && !payload.value) return <Skeleton />;
  if (loadError.value && !payload.value) return <ErrorState msg={loadError.value} />;
  if (!payload.value) return <Skeleton />;

  switch (view.value) {
    case "leaderboard":
      return <Leaderboard />;
    case "latency":
      return <Latency />;
    case "overtime":
      return <OverTime />;
    case "resources":
      return <Resources />;
    case "matrix":
      return <Matrix />;
    case "versions":
      return <Versions />;
    case "headtohead":
      return <HeadToHead />;
    default:
      return <Leaderboard />;
  }
}

function Skeleton() {
  return (
    <div class="panel-grid" style={{ gridTemplateColumns: "1.7fr 1fr" }}>
      <div class="panel">
        <div class="panel-head"><div class="skeleton" style={{ width: "180px", height: "14px" }} /></div>
        <div class="panel-body" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Array.from({ length: 10 }).map(() => (
            <div class="skeleton" style={{ height: "18px", width: `${40 + Math.random() * 55}%` }} />
          ))}
        </div>
      </div>
      <div class="panel"><div class="panel-head"><div class="skeleton" style={{ width: "120px", height: "14px" }} /></div><div class="panel-body" /></div>
    </div>
  );
}

function ErrorState({ msg }: { msg: string }) {
  return (
    <div class="empty">
      <div class="empty-card">
        <h2>Couldn't load this run</h2>
        <p>{msg}</p>
        <p style={{ marginTop: "12px" }}>
          <button class="mini-btn" onClick={() => loadPayload(version.value, arch.value)}>Retry</button>
        </p>
      </div>
    </div>
  );
}

function NoData() {
  return (
    <div class="dash">
      <div class="dtop"><Topbar /></div>
      <div class="empty" style={{ gridRow: "2 / -1" }}>
        <div class="empty-card">
          <svg width="56" height="56" viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ margin: "0 auto 16px" }}>
            <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--surface-3)" stroke="var(--border-strong)" />
            <g stroke="var(--accent)" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 10 L15 16 L9 22" opacity="0.45" />
              <path d="M14 10 L20 16 L14 22" opacity="0.72" />
              <path d="M19 10 L25 16 L19 22" />
            </g>
          </svg>
          <h2>Benchmarks are warming up</h2>
          <p>
            The first cluster run publishes here soon. Results are produced by{" "}
            <a href="https://github.com/goceleris/probatorium" target="_blank" rel="noopener" style={{ color: "var(--accent-bright)" }}>
              probatorium
            </a>{" "}
            and rendered at build time. Meanwhile, see the{" "}
            <a href="/methodology" style={{ color: "var(--accent-bright)" }}>methodology</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
