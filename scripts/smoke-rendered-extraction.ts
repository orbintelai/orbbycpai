import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { extractDom } from "../src/lib/pipeline/runPipeline";

const url = process.argv[2];
if (!url) {
  console.error("Usage: pnpm tsx scripts/smoke-rendered-extraction.ts https://example.com");
  process.exit(1);
}

async function main() {
  const workDir = path.join(os.tmpdir(), `orb-timing-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const startedAt = performance.now();
  try {
    const result = await extractDom(url, workDir, () => {});
    console.log(JSON.stringify({
      url,
      durationMs: Math.round(performance.now() - startedAt),
      title: (result as { title?: string }).title || "",
      h1Count: ((result as { copyText?: { h1?: string[] } }).copyText?.h1 || []).length,
    }, null, 2));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
