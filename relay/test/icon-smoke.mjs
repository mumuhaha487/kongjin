import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { network } from "../scripts/network.mjs";
import { imageType } from "../src/icon.mjs";
export async function iconSmoke(base, proxy) {
  const client = network(proxy);
  try {
    for (const host of ["www.cloudflare.com", "www.baidu.com"]) {
      const response = await client.fetch(base + "/v1/icon?host=" + host);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status !== 200) continue;
      assert.equal(response.headers.get("Content-Type"), imageType(bytes));
      assert.ok(bytes.length <= 131072);
      const cached = await client.fetch(base + "/v1/icon?host=" + host);
      assert.equal(cached.status, 200);
      assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), bytes);
      return { result: "passed", host, bytes: bytes.length, type: imageType(bytes) };
    }
    throw new Error("No permitted public icon fetched successfully");
  } finally { await client.close(); }
}
if (process.argv[1]?.endsWith("icon-smoke.mjs")) {
  const base = process.argv[2], proxy = process.argv.includes("--proxy") ? process.argv[process.argv.indexOf("--proxy") + 1] : undefined;
  const result = { timestamp: new Date().toISOString(), base, ...await iconSmoke(base, proxy) };
  const label = base.includes("kongjing.inc.re") ? "online" : base.includes("8791") ? "worker" : "local";
  await writeFile(new URL("../artifacts/icon-" + label + ".json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
