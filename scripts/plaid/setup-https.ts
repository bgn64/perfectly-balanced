import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const directory=new URL("../../backups/local-https/",import.meta.url);
await mkdir(directory,{ recursive:true,mode:0o700 });
const key=fileURLToPath(new URL("key.pem",directory)),cert=fileURLToPath(new URL("cert.pem",directory));
for (const path of [key,cert]) await writeFile(path,"",{ flag:"wx",mode:0o600 });
execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","30",
  "-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1,DNS:localhost"],{ stdio:"pipe" });
await chmod(key,0o600); await chmod(cert,0o600);
const path=new URL("../../supabase/.env.local",import.meta.url);
const current=await readFile(path,"utf8");
const origin="https://127.0.0.1:5174";
const updated=current.replace(/^APP_ALLOWED_ORIGINS=(.*)$/m,(_match,origins:string) =>
  `APP_ALLOWED_ORIGINS=${[...new Set([...origins.split(","),origin])].join(",")}`)
  .replace(/^PLAID_REDIRECT_URI=.*$/m,`PLAID_REDIRECT_URI=${origin}/connections`);
await writeFile(path,updated,{ mode:0o600 });
console.log("Local HTTPS configured. Register https://127.0.0.1:5174/connections in Plaid Sandbox, trust the local certificate, restart functions, then run npm run dev:https.");
