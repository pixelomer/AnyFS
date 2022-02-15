import { AnyFS } from "./anyfs";
import { AnyFSFile } from "./fs-file";
import { AnyFSObject } from "./fs-object";
import { AnyFSFolderEntry, AnyFSFolderMetadata, ObjectID } from "./internal-types";
import { AnyFSReader } from "./reader";
import { AnyFSWriter } from "./writer";

export interface AnyFSFolder {
	parent: AnyFSFolder;
}

export class AnyFSFolder extends AnyFSObject {
	isFolder() {
		return true;
	}
	
	private async _listContents(reader: AnyFSReader): Promise<AnyFSFolderEntry[]> {
		const objectData = await reader.readObject<AnyFSFolderMetadata>(this.objectID);
		return objectData.metadata.entries;
	}

	async listContents(): Promise<AnyFSFolderEntry[]> {
		const reader = await this.FS._getRead();
		try {
			return await this._listContents(reader);
		}
		finally {
			reader.release();
		}
	}

	private static _splitComponents(path: string) {
		return path.split("/").filter((a) => a !== '');
	}

	private async _atPath(components: string[]): Promise<AnyFSFile | AnyFSFolder> {
		let folder: AnyFSFolder | AnyFSFile = this;
		for (const component of components) {
			if (!(folder instanceof AnyFSFolder)) {
				return null;
			}
			else if (component === '.') {
				continue;
			}
			else if (component === '..') {
				folder = folder.parent;
				continue;
			}
			try {
				folder = await folder.get(component);
			}
			catch {
				return null;
			}
		}
		return folder;
	}

	static basename(path: string) {
		const components = this._splitComponents(path);
		return components[components.length-1];
	}

	async atPath(path: string): Promise<AnyFSFile | AnyFSFolder> {
		if (path.startsWith("/") && (this.name !== "/")) {
			const root = await this.FS.root();
			return await root.atPath(path);
		}
		const components = AnyFSFolder._splitComponents(path);
		return await this._atPath(components);
	}

	async parentForPath(path: string, shouldExist?: boolean): Promise<AnyFSFolder> {
		const components = AnyFSFolder._splitComponents(path);
		const parent = await this._atPath(components.slice(0, components.length-1));
		if (!(parent instanceof AnyFSFolder)) {
			throw new Error("Not a directory.");
		}
		if (shouldExist != null) {
			const exists = await parent.exists(components[components.length-1]);
			if (shouldExist && !exists) {
				throw new Error("No such file or directory.");
			}
			else if (!shouldExist && exists) {
				throw new Error("File exists.");
			}
		}
		return parent;
	}

	static async create(FS: AnyFS, parent: AnyFSObject, name: string): Promise<AnyFSFolder> {
		const writer = await FS._getWrite();
		try {
			const objectID = await writer.createObject();
			await writer.writeObject<AnyFSFolderMetadata>(objectID, {
				metadata: {
					type: "folder",
					entries: []
				},
				data: null
			});
			return new this(FS, parent, name, objectID);
		}
		finally {
			writer.release();
		}
	}

	private async _getEntry(name: string, reader?: AnyFSReader): Promise<AnyFSFolderEntry> {
		const contents = (
			(reader == null) ?
			await this.listContents() :
			await this._listContents(reader)
		);
		const object = contents.find((value) => value.name === name);
		return object;
	}

	async get(name: string, reader?: AnyFSReader): Promise<AnyFSFolder | AnyFSFile> {
		const entry = await this._getEntry(name, reader);
		if (entry == null) {
			return null;
		}
		if (entry.type === 'file') {
			return new AnyFSFile(this.FS, this, name, entry.objectID);
		}
		else if (entry.type === 'folder') {
			return new AnyFSFolder(this.FS, this, name, entry.objectID);
		}
		throw new Error("The requested file has an unknown type. It might be corrupted.");
	}

	getAbsolutePath() {
		const components = [];
		let folder: AnyFSFolder = this;
		while (folder.name !== "/") {
			components.push(folder.name);
			folder = folder.parent;
		}
		components.reverse();
		return `/${components.join("/")}`;
	}

	async exists(name: string): Promise<boolean> {
		return (await this._getEntry(name)) != null;
	}

	async link(name: string, type: "folder" | "file", objectID: ObjectID, force?: boolean): Promise<void> {
		const writer = await this.FS._getWrite();
		try {
			const oldItem = await this.get(name, writer);
			if (oldItem != null) {
				if ((force == null) || !force) {
					throw new Error("File exists.");
				}
				if (!oldItem.isFile()) {
					throw new Error("Is a directory.");
				}
				await this.deleteEntry(oldItem.name, writer, true);
			}
			else if (["..", "."].includes(name)) {
				throw new Error("Reserved name.");
			}
			else if (name.includes("/")) {
				throw new Error("Filenames cannot contain slashes (/).");
			}
			const objectData = await writer.readObject<AnyFSFolderMetadata>(this.objectID);
			const entries = objectData.metadata.entries;
			entries.push({ type, name, objectID });
			await writer.writeObject(this.objectID, objectData);
		}
		finally {
			writer.release();
		}
	}

	async deleteEntry(name: string): Promise<void>;
	async deleteEntry(name: string, force: boolean): Promise<void>;
	async deleteEntry(name: string, writer: AnyFSWriter): Promise<void>;
	async deleteEntry(name: string, writer: AnyFSWriter, force: boolean): Promise<void>;
	
	async deleteEntry(name: string, arg2?: AnyFSWriter | boolean, arg3?: boolean): Promise<void> {
		let writer: AnyFSWriter;
		let releaseWriter = true;
		let force: boolean = false;
		if (arg2 instanceof AnyFSWriter) {
			writer = arg2;
			arg2 = arg3;
			releaseWriter = false;
		}
		else {
			writer = await this.FS._getWrite();
		}
		if (typeof arg2 === 'boolean') {
			force = arg2;
		}
		try {
			const objectData = await writer.readObject<AnyFSFolderMetadata>(this.objectID);
			const entryIndex = objectData.metadata.entries.findIndex((value) => value.name === name);
			if (entryIndex === -1) {
				throw new Error("No such file or directory.");
			}
			else if (!force && (objectData.metadata.entries[entryIndex].type === 'folder')) {
				//@ts-ignore
				const subFolder: AnyFSFolder = await this.get(name, writer);
				const contents = await subFolder._listContents(writer);
				if (contents.length !== 0) {
					throw new Error("Directory not empty.");
				}
			}
			const [removedEntry] = objectData.metadata.entries.splice(entryIndex, 1);
			const removedItem = await this.get(removedEntry.name, writer);
			await writer.writeObject(this.objectID, objectData);
			if (!force) {
				if (removedItem.isFile()) {
					await removedItem.truncate();
				}
				await writer.deleteObject(removedItem.objectID);
			}
		}
		finally {
			if (releaseWriter) {
				writer.release();
			}
		}
	}

	async createFile(name: string): Promise<AnyFSFile> {
		const file = await AnyFSFile.create(this.FS, this, name);
		await this.link(name, "file", file.objectID);
		return file;
	}

	async createFolder(name: string): Promise<AnyFSFolder> {
		const folder = await AnyFSFolder.create(this.FS, this, name);
		await this.link(name, "folder", folder.objectID);
		return folder;
	}
}