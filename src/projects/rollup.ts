import type { JSONContent } from "@tiptap/react";
import { extractTasks, projectTag, projectTasks, setTaskChecked, type Task } from "../lib/projects";
import { docText } from "../lib/words";
import type { JournalStore, NamedPage } from "../store";

/** A task that belongs to a project, and where it's written. */
export interface RolledTask {
  task: Task;
  day: string | null;
  title: string | null;
}

/** The project page's own tasks, plus every task elsewhere that links to it or carries its tag. */
export async function loadProjectTasks(store: JournalStore, project: NamedPage): Promise<RolledTask[]> {
  const own = await store.getPage(project.title);
  const out: RolledTask[] = (own ? extractTasks(own.content) : []).map((task) => ({ task, day: null, title: project.title }));
  const refs = [...(await store.references("wikilink", project.title)), ...(await store.references("tag", projectTag(project.title)))];
  const seen = new Set<string>([project.id]);
  for (const ref of refs) {
    if (seen.has(ref.blockId)) continue;
    seen.add(ref.blockId);
    for (const task of projectTasks(ref.content, project.title)) out.push({ task, day: ref.day, title: ref.title });
  }
  return out;
}

/** Ticks or unticks a task in the day or page it's written in (saved with an event, like any edit). */
export async function setRolledTask(store: JournalStore, item: RolledTask, checked: boolean) {
  const save = async (content: JSONContent) => setTaskChecked(content, item.task.path, checked);
  if (item.day) {
    const page = await store.getDay(item.day);
    if (!page) return;
    const content = await save(page.content);
    await store.saveDay({ day: item.day, content, plainText: docText(content) });
  } else if (item.title) {
    const page = await store.getPage(item.title);
    if (!page) return;
    const content = await save(page.content);
    await store.savePage({ id: page.id, content, plainText: docText(content) });
  }
}
