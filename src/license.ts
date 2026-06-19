import nacl from "tweetnacl";

// Offline Ed25519 license verification for Highlight Inbox Synthesizer.
// A license key is base64(JSON({ p, s })) where:
//   p = base64 of the UTF-8 payload JSON
//   s = base64 of the Ed25519 detached signature over the payload bytes
// Verification is fully offline against the embedded public key.

const PUBLIC_KEY_B64 = "baL5i2Qkx2cNfzBSkZPQ5szPJ/UTOuxa/Q112ZUzdHQ=";
const PRODUCT_ID = "highlight-inbox-synthesizer";

interface LicensePayload {
	product: string;
	email: string;
	issued: string;
}

export interface LicenseStatus {
	valid: boolean;
	email?: string;
	issued?: string;
	reason?: string;
}

function b64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function verifyLicense(licenseKey: string): LicenseStatus {
	const key = (licenseKey || "").trim();
	if (!key) {
		return { valid: false, reason: "No license key provided." };
	}

	try {
		const bundleJson = bytesToUtf8(b64ToBytes(key));
		const bundle = JSON.parse(bundleJson) as { p?: string; s?: string };

		if (!bundle.p || !bundle.s) {
			return { valid: false, reason: "Malformed license key." };
		}

		const payloadBytes = b64ToBytes(bundle.p);
		const signature = b64ToBytes(bundle.s);
		const publicKey = b64ToBytes(PUBLIC_KEY_B64);

		const signatureOk = nacl.sign.detached.verify(
			payloadBytes,
			signature,
			publicKey
		);
		if (!signatureOk) {
			return { valid: false, reason: "Invalid signature." };
		}

		const payload = JSON.parse(bytesToUtf8(payloadBytes)) as LicensePayload;
		if (payload.product !== PRODUCT_ID) {
			return { valid: false, reason: "License is for a different product." };
		}

		return { valid: true, email: payload.email, issued: payload.issued };
	} catch {
		return { valid: false, reason: "Could not read license key." };
	}
}
