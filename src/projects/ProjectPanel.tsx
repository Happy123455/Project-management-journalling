import { showToast } from "../lib/toast";
import { MAX_ACTIVE_PROJECTS } from "../lib/projects";
import { useEffect, useState } from "react";
import type { ProjectStatus } from "../lib/projects";
import { projectTag } from "../lib/projects";
import { dayTitle } from "../lib/timestamp";
import type { JournalStore, NamedPage } from "../store";
import { loadProjectTasks, setRolledTask, type RolledTask } from "./rollup";

const STATUSES: { value: ProjectStatus; label: string }[] = [
  { value: "active", label: "● Active" },
  { value: "paused", label: "❚❚ Paused" },
  { value: "done", label: "✓ Done" },
];

/** On a project's page: its status, and every task that belongs to it, wherever it's written. */
export function ProjectPanel({ store, page, refreshKey, onChanged, onOpenDay }: {
  store: JournalStore;
  page: NamedPage;
  refreshKey: unknown;
  onChanged: (page: NamedPage) => void;
  onOpenDay: (day: string) => void;
}) {
  const [tasks, setTasks] = useState<RolledTask[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    loadProjectTasks(store, page).then((t) => live && setTasks(t));
    return () => {
      live = false;
    };
  }, [store, page, refreshKey, tick]);

  const status = page.props.project?.status ?? "active";
  const open = tasks?.filter((t) => !t.task.checked) ?? [];
  const done = tasks?.filter((t) => t.task.checked) ?? [];

  const toggle = async (item: RolledTask) => {
    await setRolledTask(store, item, !item.task.checked);
    setTick((n) => n + 1);
  };

  const row = (item: RolledTask, i: number) => (
    <li key={i} className={item.task.checked ? "project-task done" : "project-task"}>
      <input type="checkbox" checked={item.task.checked} onChange={() => void toggle(item)} aria-label={item.task.text} />
      <span className="project-task-text">{item.task.text}</span>
      {item.day && (
        <button type="button" className="project-task-where" onClick={() => onOpenDay(item.day!)}>
          {dayTitle(item.day).replace(/^\w+, /, "")}
        </button>
      )}
    </li>
  );

  return (
    <section className="project-panel">
      <div className="project-status" role="radiogroup" aria-label="Project status">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={status === s.value}
            className={status === s.value ? `active status-${s.value}` : ""}
            onClick={async () => {
              if (s.value === "active" && status !== "active") {
                const active = (await store.projects()).filter((p) => p.id !== page.id && (p.props.project?.status ?? "active") === "active");
                if (active.length >= MAX_ACTIVE_PROJECTS) {
                  return showToast(`${MAX_ACTIVE_PROJECTS} projects are already active (${active.map((p) => p.title).join(", ")}). Pause one first.`, "error");
                }
              }
              onChanged(await store.setPageProps(page.id, { project: { status: s.value } }));
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="hint">
        Tasks here, and any ☑ task anywhere with [[{page.title}]] or #{projectTag(page.title)}, show up below.
      </p>
      {tasks && (
        <>
          <h3>To do · {open.length}</h3>
          {open.length ? <ul className="project-tasks">{open.map(row)}</ul> : <p className="hint">Nothing open.</p>}
          {done.length > 0 && (
            <>
              <h3>Done · {done.length}</h3>
              <ul className="project-tasks">{done.map(row)}</ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** The drawer's Projects list: active ones first (up to four), with open-task counts. */
export function ProjectList({ store, refreshKey, onOpen }: { store: JournalStore; refreshKey: unknown; onOpen: (title: string) => void }) {
  const [items, setItems] = useState<{ page: NamedPage; open: number; total: number }[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const projects = (await store.projects()).filter((p) => p.props.project?.status !== "done");
      projects.sort((a, b) => Number(b.props.project?.status === "active") - Number(a.props.project?.status === "active"));
      const rows = [];
      for (const page of projects.slice(0, 4)) {
        const tasks = await loadProjectTasks(store, page);
        rows.push({ page, open: tasks.filter((t) => !t.task.checked).length, total: tasks.length });
      }
      if (live) setItems(rows);
    })();
    return () => {
      live = false;
    };
  }, [store, refreshKey]);
  if (!items.length) return null;
  return (
    <div className="project-list">
      <h2>Projects</h2>
      <ul>
        {items.map(({ page, open, total }) => (
          <li key={page.id}>
            <button type="button" onClick={() => onOpen(page.title)}>
              <span className={`project-dot status-${page.props.project?.status}`} />
              <span className="project-name">{page.title}</span>
              <span className="project-count">{total ? `${total - open}/${total}` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
