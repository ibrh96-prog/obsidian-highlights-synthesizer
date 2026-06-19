import nacl from "tweetnacl";

// Offline Ed25519 license minting for Highlight Inbox Synthesizer.
// Usage: HIGHLIGHT_INBOX_PRIVATE_KEY="<base64 secret key>" npm run mint -- <buyer-email>
// The private key is read ONLY from the environment and is never written to disk.

const PRIVATE_KEY_B64 = process.env.HIGHLIGHT_INBOX_PRIVATE_KEY;
if (!PRIVATE_KEY_B64) {
	console.error(
		"Error: HIGHLIGHT_INBOX_PRIVATE_KEY environment variable is not set."
	);
	process.exit(1);
}

const email = process.argv[2];
if (!email) {
	console.error(
		'Usage: HIGHLIGHT_INBOX_PRIVATE_KEY="<key>" npm run mint -- <buyer-email>'
	);
	process.exit(1);
}

const secretKey = new Uint8Array(Buffer.from(PRIVATE_KEY_B64, "base64"));
if (secretKey.length !== 64) {
	console.error(
		"Error: private key must be a 64-byte Ed25519 secret key (base64)."
	);
	process.exit(1);
}

const payload = {
	product: "highlight-inbox-synthesizer",
	email,
	issued: new Date().toISOString().slice(0, 10),
};

const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
const signature = nacl.sign.detached(payloadBytes, secretKey);

const bundle = {
	p: Buffer.from(payloadBytes).toString("base64"),
	s: Buffer.from(signature).toString("base64"),
};

const licenseKey = Buffer.from(JSON.stringify(bundle)).toString("base64");

console.log("\nLicense key for " + email + ":\n");
console.log(licenseKey);
console.log("");
