import { join } from 'node:path';
import type { TabsFile } from '@shared/model';
import { loadValidated, writeFileAtomic } from './atomic';
import { tabsSchema } from './schemas';

export class TabsStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.path = join(dir, 'tabs.json');
  }

  async load(): Promise<TabsFile> {
    try {
      const loaded = await loadValidated<TabsFile>(this.path, tabsSchema);
      if (loaded.value) return loaded.value;
      return { version: 1, tabs: [], activeTabId: null, ...(loaded.notice ? { notice: loaded.notice } : {}) };
    } catch {
      return { version: 1, tabs: [], activeTabId: null };
    }
  }

  save(file: TabsFile): Promise<void> {
    const next = this.queue.then(() => writeFileAtomic(this.path, JSON.stringify(file)));
    this.queue = next.catch(() => undefined);
    return next;
  }
}
