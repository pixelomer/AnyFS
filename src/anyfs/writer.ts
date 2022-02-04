import { AnyFSReader } from "./reader";
import { AnyFSObjectRaw, ObjectID } from "./internal-types";
import crypto from "crypto";
import v8 from "v8";

export class AnyFSWriter extends AnyFSReader {
	private _ongoingWriteCount = 0;

	release() {
		if (this._ongoingWriteCount !== 0) {
			throw new Error("Cannot release a writer while there are ongoing writes.");
		}
		super.release();
	}

	private async _performWrite<T>(run: () => Promise<T>): Promise<T> {
		if (this.invalidated) {
			throw new Error("This writer was invalidated.");
		}
		this._ongoingWriteCount++;
		try {
			return await run();
		}
		finally {
			this._ongoingWriteCount--;
		}
	}

	async writeObject<T>(objectID: ObjectID, object: AnyFSObjectRaw<T>) {
		await this._performWrite(async() => {
			//console.log("[WRITE]", { objectID, ...object });

			// Generate unencrypted data
			const jsonData = Buffer.from(JSON.stringify(object.metadata), 'utf-8');
			const hasData = (object.data != null);
			const unencryptedSize = jsonData.length + (hasData ? (object.data.length + 1) : 0);
			const unencrypted = Buffer.allocUnsafe(unencryptedSize);
			jsonData.copy(unencrypted);
			if (hasData) {
				unencrypted[jsonData.length] = 0;
				object.data.copy(unencrypted, jsonData.length + 1);
			}

			// Encrypt data (AES256)
			const iv = crypto.randomBytes(16);
			const cipher = crypto.createCipheriv('aes-256-cbc', this.FS._AESKey, iv);
			const incomplete = cipher.update(unencrypted);
			const encrypted = Buffer.concat([iv, incomplete, cipher.final()]);

			await this.FS._FSProvider.writeObject(objectID, encrypted);

			this.FS._cache.set(objectID, v8.deserialize(v8.serialize(object)));
		});
	}

	async createObject(): Promise<ObjectID> {
		return await this._performWrite<ObjectID>(async() => {
			return await this.FS._FSProvider.createObject();
		});
	}

	async deleteObject(objectID: ObjectID): Promise<boolean> {
		return await this._performWrite<boolean>(async() => {
			if (this.FS._FSProvider.deleteObject != null) {
				return await this.FS._FSProvider.deleteObject(objectID);
			}
			else {
				return false;
			}
		});
	}
}