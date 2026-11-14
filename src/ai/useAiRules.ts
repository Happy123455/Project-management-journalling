import { useEffect, useRef } from "react";
import type { JournalStore } from "../store";
import { dueRule, firedKey, parseRules, RULES_PAGE, targetDay, type AiRule } from "../lib/aiRules";
import { pageLines } from "../lib/specialDates";
import { isTyping } from "../lib/toast";
import { AI_OPEN_EVENT } from "./journalTools";

const FIRED_KEY = "dynamic-journal.rules-fired";

function loadFired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveFired(s: Set<string>) {
  try {
    // Only the last few days' keys matter.
    localStorage.setItem(FIRED_KEY, JSON.stringify([...s].slice(-60)));
  } catch {
    // A rule may fire again; harmless.
  }
}

/**
 * Opens notes by themselves: what the AI asks for (open_note) right away, and the "AI rules" page's
 * rules when the app opens or comes back and at their times. Never while you type: it waits.
 * Checks once a minute only while the app is on screen.
 */
export function useAiNavigation(store: JournalStore | null, open: (target: string) => void) {
  const openRef = useRef(open);
  openRef.current = open;

  // The AI's open_note.
  useEffect(() => {
    let wait = 0;
    const go = (target: string) => {
      if (isTyping()) {
        window.clearTimeout(wait);
        wait = window.setTimeout(() => go(target), 1500);
        return;
      }
      const day = targetDay(target, new Date());
      openRef.current(day ?? target);
    };
    const on = (e: Event) => {
      const t = (e as CustomEvent<{ target?: string }>).detail?.target;
      if (t) go(t);
    };
    window.addEventListener(AI_OPEN_EVENT, on);
    return () => {
      window.removeEventListener(AI_OPEN_EVENT, on);
      window.clearTimeout(wait);
    };
  }, []);

  // The rules.
  useEffect(() => {
    if (!store) return;
    let rules: AiRule[] = [];
    let timer = 0;
    let alive = true;
    const load = async () => {
      const page = await store.getPage(RULES_PAGE).catch(() => null);
      rules = parseRules(pageLines(page?.content));
    };
    const check = (opening: boolean) => {
      if (!rules.length || document.visibilityState !== "visible" || isTyping()) return;
      const now = new Date();
      const fired = loadFired();
      const r = dueRule(rules, now, opening, fired);
      if (!r) return;
      fired.add(firedKey(r, now));
      saveFired(fired);
      const day = targetDay(r.target, now);
      if (day) return openRef.current(day);
      void store.getPage(r.target).then((p) => p && openRef.current(p.title));
    };
    const tick = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible" || !rules.length) return;
      // At the start of the next minute.
      timer = window.setTimeout(() => {
        // Read again each minute (a cheap local read), so edits to the page count soon.
        void load().then(() => {
          if (!alive) return;
          check(false);
          tick();
        });
      }, 60_000 - (Date.now() % 60_000) + 200);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return window.clearTimeout(timer);
      void load().then(() => alive && (check(true), tick()));
    };
    const onChanged = () => void load().then(() => alive && tick());
    void load().then(() => {
      if (!alive) return;
      // A moment after opening, so the app's own first page is up.
      window.setTimeout(() => alive && check(true), 1500);
      tick();
    });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("journal:rules-changed", onChanged);
    window.addEventListener("journal:synced", onChanged);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("journal:rules-changed", onChanged);
      window.removeEventListener("journal:synced", onChanged);
    };
  }, [store]);
}
