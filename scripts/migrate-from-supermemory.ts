/**
 * One-time migration: export ALL memories from the Supermemory cloud API
 * into the local store. Run once, then switch storageBackend to "local"
 * (the default) and you never need the cloud again.
 *
 * Enumerates the account-wide list (no container-tag filter) so memories
 * stored under per-project tags (repo_<name>__<hash>) are found too.
 *
 * Usage:
 *   SUPERMEMORY_API_KEY=sk-... bun scripts/migrate-from-supermemory.ts
 *
 * Optional flags:
 *   --dry-run       show what would be imported without writing
 *   --limit N       cap the number of memories (default: all)
 */
import Supermemory from "supermemory";
import { getApiBaseUrl, SUPERMEMORY_API_KEY } from "../src/config.ts";
import { localMemoryStore } from "../src/services/local-store.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx > -1 ? Number(args[limitIdx + 1]) : undefined;
const tagIdx = args.indexOf("--tag");
const tag = tagIdx > -1 ? args[tagIdx + 1] : undefined;

if (!SUPERMEMORY_API_KEY) {
  console.error("SUPERMEMORY_API_KEY is required to export from the cloud.");
  process.exit(1);
}

if (dryRun) console.log("DRY RUN — nothing will be written.\n");

async function main() {
  const client = new Supermemory({
    apiKey: SUPERMEMORY_API_KEY,
    baseURL: getApiBaseUrl(),
  });

  let imported = 0;
  let skipped = 0;
  let page = 1;

  for (;;) {
    // No containerTags = account-wide list (if the API honors it). When a
    // --tag is given, filter to that container. Paginate until exhausted.
    const res = await client.memories.list({
      limit: 100,
      includeContent: true,
      order: "desc",
      sort: "updatedAt",
      ...(tag ? { containerTags: [tag] } : {}),
    });
    const memories = (res.memories || []) as Array<{
      id: string;
      content?: string | null;
      summary?: string | null;
      title?: string | null;
      containerTags?: string[] | null;
      updatedAt?: string;
    }>;
    console.log(`page ${page}: ${memories.length} memories (total ${res.pagination?.totalItems ?? "?"})`);

    if (memories.length === 0 && page === 1) {
      console.warn(
        "\nNo memories returned. Possible causes:\n" +
          "  1. The account-wide list requires a containerTag filter on this API version.\n" +
          "     Try: bun scripts/migrate-from-supermemory.ts --tag <your-tag>\n" +
          "  2. Nothing was ever captured to the cloud (the plugin was broken before the\n" +
          "     recall fixes), so there may be nothing to migrate.\n" +
          "Tip: find your tags with a search from a working session, or check the\n" +
          "     Supermemory dashboard for the container tags in use.\n",
      );
    }

    for (const m of memories) {
      if (limit !== undefined && imported >= limit) {
        console.log(`\nReached --limit ${limit}. Stopping.`);
        return;
      }
      const content = m.content ?? m.summary ?? "";
      if (!content?.trim()) {
        skipped++;
        continue;
      }
      // Use the memory's own container tags; fall back to "opencode".
      const containerTag =
        Array.isArray(m.containerTags) && m.containerTags.length > 0
          ? m.containerTags[0]
          : "opencode";
      const customId = `sm-import-${m.id}`;

      if (dryRun) {
        console.log(`  [dry] [${containerTag}] ${content.slice(0, 80)}`);
        imported++;
        continue;
      }

      const result = await localMemoryStore.addMemory(
        content,
        containerTag,
        {
          type: "conversation",
          sm_scope: "personal",
          sm_imported: true,
          title: m.title ?? undefined,
        },
        { customId },
      );
      if (result.success) {
        imported++;
        console.log(`  [ok] [${containerTag}] ${content.slice(0, 80)}`);
      } else {
        skipped++;
        console.log(`  [skip] ${content.slice(0, 60)} — ${result.error}`);
      }
    }

    const { totalPages, currentPage } = res.pagination ?? {};
    if (currentPage === undefined || currentPage >= (totalPages ?? 1) || memories.length === 0) break;
    page++;
  }

  console.log(`\nDone. ${imported} imported, ${skipped} skipped.${dryRun ? " (dry run)" : ""}`);
  localMemoryStore.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
