import { LocalMemoryStore } from "../src/services/local-store.ts";

const store = new LocalMemoryStore();
const TAG = "repo_test__1234567890abcdef";
const TAG2 = "repo_other__fedcba0987654321";

async function main() {
  // 1. addMemory + search round trip
  const add = await store.addMemory(
    "the auth flow uses JWT with refresh tokens",
    TAG,
    { type: "project-config", sm_scope: "project" },
  );
  console.log("add:", add.success ? "OK" : "FAIL", add.id ? add.id.slice(0, 8) : add.error);

  const add2 = await store.addMemory(
    "user prefers Go for backend services",
    TAG,
    { type: "preference", sm_scope: "personal" },
  );
  console.log("add2:", add2.success ? "OK" : "FAIL");

  const search = await store.searchMemoriesScoped("auth JWT", TAG, [TAG], "project");
  console.log("search results:", search.results?.length, "| first:", search.results?.[0]?.memory?.slice(0, 50));

  // 2. ingest conversation + search it back
  const ingest = await store.ingestConversation(
    "conv-001",
    [
      { role: "user", content: "how should we handle rate limiting" },
      { role: "assistant", content: "use token bucket at the gateway, 100 req/min per key" },
    ],
    [TAG2],
    { project: "test", sm_scope: "personal" },
  );
  console.log("ingest:", ingest.success ? "OK" : "FAIL", ingest.success ? ingest.status : ingest.error);

  const recall = await store.searchMemoriesScoped("rate limiting gateway", TAG2, [TAG2], "personal");
  console.log("recall:", recall.results?.length, "| first:", recall.results?.[0]?.memory?.slice(0, 60));

  // 3. list
  const list = await store.listMemoriesScoped(TAG, [TAG], "project", 10);
  console.log("list count:", list.memories.length);

  // 4. delete
  if (add.success) {
    const del = await store.deleteMemory(add.id!);
    console.log("delete:", del.success ? "OK" : "FAIL");
    const after = await store.searchMemoriesScoped("auth JWT", TAG, [TAG], "project");
    console.log("after delete count:", after.results?.length);
  }

  // 5. profile
  const profile = await store.getProfileScoped(TAG, [TAG], "personal");
  console.log("profile static:", profile.profile?.static?.length, "items");

  store.close();
  console.log("DONE");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
