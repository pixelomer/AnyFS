import { AnyFSFolder } from "./fs-folder";
import { Readable, Writable } from "stream";
import { AnyFS } from "./anyfs";
import { AnyFSFile } from "./fs-file";
//@ts-ignore
import { FileSystem } from "ftp-srv";

class AnyFSFTPFileSystem extends FileSystem {
	anyfsCwd: AnyFSFolder;

	async _get(cwd: AnyFSFolder, filename: string): Promise<any> {
		const file = await cwd.atPath(filename);
		if (file == null) {
			throw new Error("No such file or directory.");
		}
		const basename = AnyFSFolder.basename(filename);
		if (file.isFolder()) {
			return {
				name: basename,
				isDirectory: () => true,
				size: 1,
				atime: new Date(0),
				mtime: new Date(0),
				ctime: new Date(0),
				uid: 0,
				gid: 0
			};
		}
		else if (file.isFile()) {
			const stat = await file.stat();
			return {
				name: basename,
				isDirectory: () => false,
				size: stat.size,
				atime: new Date(0),
				mtime: new Date(0),
				ctime: new Date(0),
				uid: 0,
				gid: 0
			};
		}
	}

	get(filename: string): Promise<any> {
		return this._get(this.anyfsCwd, filename);	
	}

	async list(path: string = ".") {
		const file = await this.anyfsCwd.atPath(path);
		if (file == null) {
			throw new Error("No such file or directory.");
		}
		if (!file.isFolder()) {
			throw new Error("Not a directory.");
		}
		const contents = await this.anyfsCwd.listContents();
		const list = [];
		for (const item of contents) {
			try {
				list.push(await this._get(file, item.name));
			}
			catch {}
		}
		return list;
	}

	currentDirectory(): string {
		return this.anyfsCwd.getAbsolutePath();
	}

	async chdir(path: string = "."): Promise<string> {
		const newCwd = await this.anyfsCwd.atPath(path);
		if (newCwd == null) {
			throw new Error("No such file or directory.");
		}
		else if (!newCwd.isFolder()) {
			throw new Error("Not a directory.");
		}
		else {
			this.anyfsCwd = newCwd;
		}
		return this.anyfsCwd.getAbsolutePath();
	}

	async write(filename: string, options?: { append?: boolean; start?: any; }): Promise<any> {
		const parent = await this.anyfsCwd.parentForPath(filename);
		const basename = AnyFSFolder.basename(filename);
		let file: AnyFSFile;
		if (!(await parent.exists(basename))) {
			file = await parent.createFile(basename);
		}
		else {
			const atPath = await this.anyfsCwd.atPath(filename);
			if (!atPath.isFile()) {
				throw new Error("Is a directory.");
			}
			file = atPath;
		}
		const stat = await file.stat();
		const append = (options?.append != null) ? !!options.append : false;
		const start = (typeof options?.start === 'number') ? options.start : 0;
		if (!append && (start !== stat.size)) {
			throw new Error(`Writing in the middle of a file is not supported. Delete and reupload instead. (filesize=${stat.size}, offset=${start})`);
		}
		const stream = new Writable({
			write: async function(chunk, encoding, callback) {
				if (!(chunk instanceof Buffer)) {
					chunk = Buffer.from(chunk);
				}
				try {
					await file.append(chunk);
					callback();
				}
				catch (err) {
					callback(err);
				}
			}
		});
		return {
			stream: stream,
			clientPath: file.getAbsolutePath()
		}
	}

	async read(filename: string, options?: { start?: any; }): Promise<any> {
		const file = await this.anyfsCwd.atPath(filename);
		if (file == null) {
			throw new Error("No such file or directory.");
		}
		else if (!file.isFile()) {
			throw new Error("Is a directory.")
		}
		if (options?.start == null) {
			options = { start: 0 };
		}
		let seek = options.start;
		return {
			stream: new Readable({
				read: async function(size) {
					if (seek == null) {
						return null;
					}
					const newSeek = seek + size;
					let data: Buffer;
					try {
						data = await file.read(seek, size);
					}
					catch (err) {
						this.destroy(err);
						return;
					}
					if (data.length === 0) {
						this.push(null);
					}
					else {
						this.push(data);
					}
					if (data.length !== size) {
						seek = null;
						this.push(null);
					}
					else {
						seek = newSeek;
					}
				}
			}),
			clientPath: file.getAbsolutePath()
		};
	}

	async delete(path: string) {
		const parent = await this.anyfsCwd.parentForPath(path, true);
		await parent.deleteEntry(AnyFSFolder.basename(path));
	}

	async mkdir(path: string) {
		const parent = await this.anyfsCwd.parentForPath(path, false);
		await parent.createFolder(AnyFSFolder.basename(path));
	}

	async rename(from: string, to: string) {
		const sourceFile = await this.anyfsCwd.atPath(from);
		if (sourceFile == null) {
			throw new Error("No such file or directory.");
		}
		const sourceParent = sourceFile.parent;
		const targetParent = await this.anyfsCwd.parentForPath(to, false);
		const sourceBasename = AnyFSFolder.basename(from);
		const targetBasename = AnyFSFolder.basename(to);
		await targetParent.link(targetBasename, sourceFile.isFile() ? "file" : "folder", sourceFile.objectID, true);
		await sourceParent.deleteEntry(sourceBasename, true);
	}

	async chmod(path: string, mode: string) {
		throw new Error("Operation not supported.");
	}
}

export async function getFTP(anyfs: AnyFS) {
	const root = await anyfs.root();
	return new (class extends AnyFSFTPFileSystem {
		constructor() {
			//@ts-ignore
			super(...arguments);
			this.anyfsCwd = root;
		}
	});
}