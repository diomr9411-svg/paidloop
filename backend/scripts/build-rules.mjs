// Rebuilds the official EN 16931 rules for Saxon-JS. Only needed if the XSLT file in assets/rules is replaced.
// Run: npm run build:rules   (takes about a minute)
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const folder = new URL("../assets/rules/", import.meta.url);
const xslt = new URL("EN16931-CII-validation.xslt", folder);
const output = join(tmpdir(), "paidloop-rules.sef.json");
execFileSync(process.execPath, [new URL("../node_modules/xslt3/xslt3.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), `-xsl:${xslt.pathname.replace(/^\/([A-Za-z]:)/, "$1")}`, `-export:${output}`, "-nogo"], { stdio: "inherit" });
writeFileSync(new URL("EN16931-CII-validation.sef.json.gz", folder), gzipSync(readFileSync(output), { level: 9 }));
rmSync(output);
console.log("Rules rebuilt.");
