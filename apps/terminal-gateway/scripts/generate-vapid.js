// Generate a VAPID keypair for Web Push and print it as env lines.
//
// VAPID (RFC 8292) is the application-server identity the push service uses to
// authenticate the gateway. Generate ONCE per deployment, paste into the
// gateway .env, and keep the keys stable — rotating them invalidates every
// existing browser subscription (each subscription is bound to the public key
// it was created with). See docs/PUSH-NOTIFICATIONS-PLAN.md.
//
//   node scripts/generate-vapid.js
//   # or: pnpm --filter @sparklab/terminal-gateway generate-vapid
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("# Web Push VAPID keys — add these to apps/terminal-gateway/.env");
console.log(
  "# Keep them stable; rotating invalidates all existing subscriptions.",
);
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(
  "# Contact URI (mailto: or https:) the push service can reach you at:",
);
console.log("VAPID_SUBJECT=mailto:admin@example.com");
