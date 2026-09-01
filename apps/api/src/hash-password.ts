import { hashPassword } from "./auth.js";

const password = process.argv[2];
if (!password) {
  console.error("usage: pnpm --filter @mini-agent/api hash-password <password>");
  process.exit(1);
}

console.log(await hashPassword(password));
