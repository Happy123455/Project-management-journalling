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
  /** A one-tap button for it on the tool bar ("quick log"). */
  quickLog?: boolean;
  /** The button's icon (an emoji). */
  icon?: string;
  /** No icon picked: the Mac's local model picks one (it arrives on the phone by sync). */
  iconAuto?: boolean;
  /** A GIF (or meme clip) from the journal's media as the button's icon, instead of the emoji. */
  iconFile?: string;
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

/**
 * Tasks that belong to a project: they link to it ([[Project X]]) or carry its tag (#project-x),
 * or they sit inside something that does: the project's box (the [[Project X]] line and the lines
 * indented under it, as "📌 Project" makes it), a heading naming it (up to the next heading of the
 * same or a higher level), or a task that names it (its sub-tasks).
 */
export function projectTasks(doc: JSONContent, name: string): Task[] {
  const want = name.trim().toLowerCase();
  const tag = projectTag(name);
  const names = (text: string) => {
    const { wikilinks, tags } = extractLinks(text);
    return wikilinks.some((l) => l.toLowerCase() === want) || tags.some((x) => x.toLowerCase() === tag || x.toLowerCase().startsWith(`${tag}/`));
  };
  // Top-level blocks inside a box or under a heading that names the project.
  const blocks = doc.content ?? [];
  const inside = new Set<number>();
  const indent = (n: JSONContent) => Number(n.attrs?.indent ?? 0);
  blocks.forEach((b, i) => {
    if (b.type !== "paragraph" && b.type !== "heading") return;
    if (!names(docText(b))) return;
    const level = Number(b.attrs?.level ?? 0);
    for (let j = i + 1; j < blocks.length; j++) {
      const n = blocks[j];
      if (b.type === "heading") {
        if (indent(n) < indent(b)) break;
        if (n.type === "heading" && indent(n) === indent(b) && Number(n.attrs?.level ?? 1) <= level) break;
        if (n.type === "horizontalRule" && indent(n) === indent(b)) break;
      } else if (indent(n) <= indent(b)) break;
      inside.add(j);
    }
  });
  const tasks = extractTasks(doc);
  // A task that names the project brings its sub-tasks along.
  const named = tasks.filter((t) => names(t.text)).map((t) => t.path.join("."));
  return tasks.filter(
    (t) => inside.has(t.path[0]) || names(t.text) || named.some((p) => t.path.join(".").startsWith(`${p}.`)),
  );
}

/** A copy of the document with the task at `path` ticked or unticked. */
export function setTaskChecked(doc: JSONContent, path: number[], checked: boolean): JSONContent {
  if (!path.length) return { ...doc, attrs: { ...doc.attrs, checked } };
  const [i, ...rest] = path;
  return { ...doc, content: (doc.content ?? []).map((c, j) => (j === i ? setTaskChecked(c, rest, checked) : c)) };
}
