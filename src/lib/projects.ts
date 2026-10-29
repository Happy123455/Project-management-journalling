import type { JSONContent } from "@tiptap/react";
import { extractLinks } from "./links";
import { docText } from "./words";

export type ProjectStatus = "active" | "paused" | "done";

/** At most this many projects are active at once (logs and people have no limit). */
export const MAX_ACTIVE_PROJECTS = 4;

/** Projects that count towards the limit: active and not logging projects. */
export const countsTowardsLimit = (p: { props: { project?: ProjectInfo } }) =>
  (p.props.project?.status ?? "active") === "active" && p.props.project?.kind !== "logging";

/** What makes a named page a project. Kept in the page's props. */
export interface ProjectInfo {
  status: ProjectStatus;
  /** A logging project: like a project, but not counted in the active limit. */
  kind?: "logging";
}

/** The tag that files a task under a project: "Project X" → "project-x". */
export function projectTag(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

export interface Task {
  /** Child indexes from the document root to the task item, to find it again. */
  path: number[];
  checked: boolean;
  text: string;
}

/** Every task (checkbox item) in a document, in order. Nested tasks are listed too. */
export function extractTasks(doc: JSONContent): Task[] {
  const out: Task[] = [];
  const walk = (node: JSONContent, path: number[]) => {
    if (node.type === "taskItem") {
      // The item's own text, without its nested sub-items.
      const own = (node.content ?? []).filter((c) => c.type !== "taskList").map(docText).join(" ").trim();
      out.push({ path, checked: !!node.attrs?.checked, text: own });
    }
    node.content?.forEach((child, i) => walk(child, [...path, i]));
  };
  walk(doc, []);
  return out;
}

/** Tasks that belong to a project: they link to it ([[Project X]]) or carry its tag (#project-x). */
export function projectTasks(doc: JSONContent, name: string): Task[] {
  const want = name.trim().toLowerCase();
  const tag = projectTag(name);
  return extractTasks(doc).filter((t) => {
    const { wikilinks, tags } = extractLinks(t.text);
    return wikilinks.some((l) => l.toLowerCase() === want) || tags.some((x) => x.toLowerCase() === tag);
  });
}

/** A copy of the document with the task at `path` ticked or unticked. */
export function setTaskChecked(doc: JSONContent, path: number[], checked: boolean): JSONContent {
  if (!path.length) return { ...doc, attrs: { ...doc.attrs, checked } };
  const [i, ...rest] = path;
  return { ...doc, content: (doc.content ?? []).map((c, j) => (j === i ? setTaskChecked(c, rest, checked) : c)) };
}
