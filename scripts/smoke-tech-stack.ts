import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractDom } from "@/lib/pipeline/extractDom";
import { detectTechnologyStack } from "@/lib/intelligence/techStack";

const url = process.argv[2];
if (!url) {
  console.error("Usage: pnpm tsx scripts/smoke-tech-stack.ts https://example.com");
  process.exit(1);
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-tech-stack-"));
  try {
    const raw = await extractDom(url, workDir, () => undefined);
    const result = detectTechnologyStack(raw as Record<string, unknown>);
    console.log(JSON.stringify({
      status: result.status,
      technologies: result.value.map((item) => ({ name: item.name, category: item.category, artifact: item.artifact })),
      evidenceCount: result.evidence.length,
    }, null, 2));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
