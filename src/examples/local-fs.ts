import { AnyFS, AnyFSProvider } from "../anyfs";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import crypto from "crypto";
import path from "path";

class LocalFSProvider implements AnyFSProvider {
	private storagePath: string;

	path(objectID: number) {
		return path.join(this.storagePath, objectID.toString());
	}
	async readObject(objectID: number) {
		return readFileSync(this.path(objectID));
	}
	async writeObject(objectID: number, data: Buffer) {
		return writeFileSync(this.path(objectID), data);
	}
	async createObject() {
		let objectID: number;
		do {
			objectID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
		}
		while (existsSync(this.path(objectID)));
		await this.writeObject(objectID, Buffer.alloc(0));
		return objectID;
	}
	async deleteObject(objectID: any): Promise<boolean> {
		try {
			const path = this.path(objectID);
			if (existsSync(path)) {
				unlinkSync(path);
				return true;
			}
			return false;
		}
		catch {
			return false;
		}
	}
	constructor(storagePath: string) {
		this.storagePath = storagePath;
	}
}

export interface LocalFSAuth {
	key: Buffer,
	root: number
};

export class LocalFS extends AnyFS {
	static async createKey(storagePath: string) {
		const provider = new LocalFSProvider(storagePath);
		const root = await provider.createObject();
		const key = crypto.randomBytes(32);
		return { root, key };
	}

	static authenticate(storagePath: string, { root, key }: LocalFSAuth) {
		const provider = new LocalFSProvider(storagePath);
		return new LocalFS(provider, key, root);
	}

	private constructor(FSProvider: LocalFSProvider, AESKey: Buffer, rootID: number) {
		super(FSProvider, AESKey, 16 * 1024, rootID);
	}
}