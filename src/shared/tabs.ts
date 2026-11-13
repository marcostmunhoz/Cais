/**
 * Which tab a single click on an environment focuses: the active tab when it already belongs
 * to that environment, else the one focused most recently (focus order kept in memory for this run of the
 * app), else the last one of it in the tab strip. Undefined when the environment has no tab: open one.
 */
export function tabForEnvironment(
  tabs: readonly { id: string; environmentId: string }[],
  activeTabId: string | null,
  focusOrder: readonly string[],
  environmentId: string,
): string | undefined {
  const mine = tabs.filter((t) => t.environmentId === environmentId);
  if (mine.length === 0) return undefined;
  if (activeTabId && mine.some((t) => t.id === activeTabId)) return activeTabId;
  const recent = focusOrder.find((id) => mine.some((t) => t.id === id));
  return recent ?? mine[mine.length - 1]!.id;
}

/** The focus order after `tabId` gains focus: most recent first, without tabs that no longer exist. */
export function focusTab(focusOrder: readonly string[], tabId: string, liveTabs?: readonly { id: string }[]): string[] {
  const next = [tabId, ...focusOrder.filter((id) => id !== tabId)];
  return liveTabs ? next.filter((id) => liveTabs.some((t) => t.id === id)) : next;
}
