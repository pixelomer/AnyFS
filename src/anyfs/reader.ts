import { AnyFS } from "./anyfs";
import v8 from "v8";
import crypto from "crypto";
import { AnyFSObjectRaw, ObjectID } from "./internal-types";

export class AnyFSReader {
	FS: AnyFS

	get invalidated() {
		return this._invalidated;
	}

	private _invalidated: boolean
	private _ongoingReadCount = 0;

	constructor(FS: AnyFS) {
		this.FS = FS;
	}

	release() {
		if (this._ongoingReadCount !== 0) {
			throw new Error("Cannot release a reader while there are ongoing reads.");
		}
		this._invalidated = true;
		this.FS._release(this);
	}

	async readObject<T>(objectID: ObjectID): Promise<AnyFSObjectRaw<T>> {
		if (this.invalidated) {
			throw new Error("This reader was invalidated.");
		}
		if (objectID == null) {
			throw new Error("Object ID must not be null.");
		}
		this._ongoingReadCount++;
		try {
			let result: AnyFSObjectRaw<T>;
			if (this.FS._cache.has(objectID)) {
				result = this.FS._cache.get(objectID);
			}
			else {
				const storedData = await this.FS._FSProvider.readObject(objectID);

				// Decrypt data (AES256)
				const iv = storedData.slice(0, 16);
				const encrypted = storedData.slice(16);
				const decipher = crypto.createDecipheriv('aes-256-cbc', this.FS._AESKey, iv);
				const incomplete = decipher.update(encrypted);
				const decrypted	= Buffer.concat([ incomplete, decipher.final() ]);

				// Parse data (JSON and binary sections)
				const jsonEnd = decrypted.indexOf(0);
				const jsonData = (jsonEnd !== -1) ? decrypted.slice(0, jsonEnd) : decrypted;
				const metadata = JSON.parse(jsonData.toString('utf-8'));
				const data = (jsonEnd !== -1) ? decrypted.slice(jsonEnd + 1) : null;

				result = { metadata, data };
				this.FS._cache.set(objectID, result);
				//console.log("[READ]", { objectID, ...result });
			}

			result = v8.deserialize(v8.serialize(result));
			return result;
		}
		finally {
			this._ongoingReadCount--;
		}
	}
}