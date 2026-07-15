import { bundle } from "@deno/emit";

/** Mapping of output file paths to JSR specifiers to bundle. */
const ENTRIES: Record<string, string> = {
  "vendor/cpx-store.js": "jsr:@chapeaux/cpx-store",
  "vendor/plugins/collab.js": "jsr:@chapeaux/cpx-store/plugins/collab",
  "vendor/transports/sse.js": "jsr:@chapeaux/cpx-store/transports/sse",
};

await Deno.mkdir("vendor/plugins", { recursive: true });
await Deno.mkdir("vendor/transports", { recursive: true });

for (const [outPath, specifier] of Object.entries(ENTRIES)) {
  console.log(`Bundling ${specifier} → ${outPath}`);
  const result = await bundle(specifier);
  await Deno.writeTextFile(outPath, result.code);
}

console.log("Done. Vendor files written.");
