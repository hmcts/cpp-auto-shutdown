#!/usr/bin/env node
import { createPrivateKey, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

try {
  const encoded = (process.env.PRIVATE_KEY_BASE64 || "").replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) throw new Error();
  const text = decoded.toString("utf8");
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n/.test(text)) throw new Error();
  const key = createPrivateKey(text);
  if (key.asymmetricKeyType !== "rsa") throw new Error();
  const pem = key.export({ type: "pkcs8", format: "pem" });
  const escape = value => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const line of pem.trim().split("\n")) console.log(`::add-mask::${escape(line)}`);
  console.log(`::add-mask::${escape(pem)}`);
  const delimiter = randomUUID();
  appendFileSync(process.env.GITHUB_OUTPUT, `private-key<<${delimiter}\n${pem}${delimiter}\n`);
} catch {
  console.error("App private key must be base64-encoded PEM containing a valid RSA private key");
  process.exitCode = 1;
}
