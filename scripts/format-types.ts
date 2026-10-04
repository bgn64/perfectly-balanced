import { readFile,writeFile } from "node:fs/promises";
const path=new URL("../packages/data/src/database.types.ts",import.meta.url);
const generated=await readFile(path,"utf8");
await writeFile(path,generated.replace(/[ \t]+$/gm,""));
