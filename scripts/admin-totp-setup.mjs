import { randomBytes } from "node:crypto";

// Run locally. The generated key and URI grant the second factor; keep both private.
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const bits = Array.from(randomBytes(20), byte => byte.toString(2).padStart(8, "0")).join("");
const secret = bits.match(/.{5}/g).map(group => alphabet[parseInt(group, 2)]).join("");
const issuer = "NodeWarden Invite";
const query = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:admin`)}?${query}`;

console.log("在验证器中手动添加账户：");
console.log(`账户：${issuer}:admin`);
console.log(`密钥：${secret}`);
console.log("类型：基于时间（TOTP），SHA1，6 位，30 秒");
console.log("\n如验证器支持导入 otpauth URI，可使用：");
console.log(uri);
console.log("\n将同一密钥添加到 Cloudflare Worker 的 ADMIN_TOTP_SECRET（Secret），保存并部署。");
console.log("请私密备份密钥。不要把密钥或 URI 发给他人、提交到 Git，或上传到在线二维码网站。");
