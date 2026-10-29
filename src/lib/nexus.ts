import type { JournalEvent } from "../store";

export interface NexusNode {
  event: JournalEvent;
  /** Column: one per device. */
  lane: number;
  /** Row: time order. */
  row: number;
  /** Another device edited the same version at the same time (this is one side of a branch). */
  concurrent: boolean;
}

export interface Nexus {
  devices: string[];
  nodes: NexusNode[];
  edges: { from: string; to: string }[];
  /** How many versions were edited on two devices at once. */
  conflicts: number;
}

/**
 * A block's history as a graph for the nexus view: its content versions (newest `limit`), a lane per
 * device, and an edge from each version to the one it was edited from. Two devices editing the same
 * version show as a branch.
 */
export function buildNexus(events: JournalEvent[], limit = 60): Nexus {
  const versions = events
    .filter((e) => e.op !== "props")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deviceId.localeCompare(b.deviceId))
    .slice(-limit);
  const devices = [...new Set(versions.map((e) => e.deviceId))];
  const shown = new Set(versions.map((e) => e.id));
  const children = new Map<string, JournalEvent[]>();
  for (const e of versions) for (const p of e.parentEventIds) children.set(p, [...(children.get(p) ?? []), e]);
  const forks = [...children.values()].filter((kids) => new Set(kids.map((k) => k.deviceId)).size > 1);
  const concurrent = new Set(forks.flat().map((e) => e.id));
  return {
    devices,
    nodes: versions.map((event, row) => ({ event, lane: devices.indexOf(event.deviceId), row, concurrent: concurrent.has(event.id) })),
    edges: versions.flatMap((e) => e.parentEventIds.filter((p) => shown.has(p)).map((p) => ({ from: p, to: e.id }))),
    conflicts: forks.length,
  };
}
