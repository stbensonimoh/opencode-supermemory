/**
 * One-time migration: export all memories from the Supermemory cloud API
 * into the local store. Run once, then switch storageBackend to "local"
 * (the default) and you never need the cloud again.
 *
 * Usage:
 *   SUPERMEMORY_API_KEY=sk-... bun scripts/migrate-from-supermemory.ts
 *
 * Optional flags:
 *   --dry-run       show what would be imported without writing
 *   --limit N       cap the number of memories (default: all)
 *   --tag TAG       only export memories for this container tag
 */
import { SupermemoryClient, type ListMemoryItem } from "../src/services/client.ts";
import { localMemoryStore } from "../src/services/local-store.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx > -1 ? Number(args[limitIdx + 1]) : undefined;
const tagIdx = args.indexOf("--tag");
const tag = tagIdx > -1 ? args[tagIdx + 1] : undefined;

if (!process.env.SUPERMEMORY_API_KEY) {
  console.error("SUPERMEMORY_API_KEY is required to export from the cloud.");
  process.exit(1);
}

if (dryRun) console.log("DRY RUN — nothing will be written.\n");

async function main() {
  const cloud = new SupermemoryClient();
  let imported = 0;
  let skipped = 0;
  let page = 1;

  // The cloud list endpoint is paginated; walk pages until exhausted.
  for (;;) {
    const res = await cloud.listMemories(tag ?? "opencode", 50);
    if (!res.success) {
      console.error(`listMemories failed: ${res.error}`);
      process.exit(1);
    }

    const memories: ListMemoryItem[] = res.memories || [];
    console.log(`page ${page}: ${memories.length} memories (total ${res.pagination.totalItems})`);

    for (const m of memories) {
      if (limit !== undefined && imported >= limit) {
        console.log(`\nReached --limit ${limit}. Stopping.`);
        return;
      }
      const content = m.content ?? m.summary ?? "";
      if (!content.trim()) {
        skipped++;
        continue;
      }
      const metadata = {
        type: (m.metadata as any)?.type ?? "conversation",
        sm_scope: (m.metadata as any)?.sm_scope ?? "personal",
        ...((m.metadata as Record<string, unknown>) ?? {}),
      };
      // Preserve the container tag the memory was originally stored under
      // (conversation ingests wrote originalContainerTags), falling back to
      // the --tag value or the default.
      const originalTags = (m.metadata as any)?.originalContainerTags;
      const containerTag =
        Array.isArray(originalTags) && originalTags.length > 0
          ? String(originalTags[0])
          : tag ?? "opencode";
      const customId = `sm-import-${m.id}`;

      if (dryRun) {
        console.log(`  [dry] ${content.slice(0, 80)}`);
        imported++;
        continue;
      }

      const result = await localMemoryStore.addMemory(
        content,
        containerTag,
        metadata,
        { customId },
      );
      if (result.success) {
        imported++;
        console.log(`  [ok] ${content.slice(0, 80)}`);
      } else {
        skipped++;
        console.log(`  [skip] ${content.slice(0, 60)} — ${result.error}`);
      }
    }

    const { totalPages, currentPage } = res.pagination;
    if (currentPage >= totalPages || memories.length === 0) break;
    page++;
  }

  console.log(`\nDone. ${imported} imported, ${skipped} skipped.${dryRun ? " (dry run)" : ""}`);
  localMemoryStore.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
