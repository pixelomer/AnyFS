import fuse from "fuse-bindings";
import fs from "fs";
import { AnyFSFile } from "./fs-file";
import { AnyFS } from "./anyfs";
import { AnyFSFolder } from "./fs-folder";
import { AnyFSMountOptions } from "./fuse";

class OpenFile {
	path: string
	fd: number
	file: AnyFSFile
	flags: number

	private _writeData: Buffer

	constructor(file: AnyFSFile, path: string, flags: number, fd: number) {
		this.fd = fd;
		this.path = path;
		this.file = file;
		this.flags = flags;
	}

	/** Writes only append. Length and position are ignored. */
	async write(position: number, length: number, data: Buffer) {
		if (this._writeData == null) {
			this._writeData = Buffer.alloc(0);
		}
		this._writeData = Buffer.concat([ this._writeData, data ]);
		if (this._writeData.length >= this.file.FS.chunkSize * 4) {
			await this.flush();
		}
	}

	async read(position: number, length: number): Promise<Buffer> {
		if ((this._writeData != null) && (this._writeData.length !== 0)) {
			throw new Error("Cannot read while a write is pending.");
		}
		return await this.file.read(position, length);
	}

	async flush() {
		if (this._writeData == null) {
			return;
		}
		const newData = this._writeData;
		this._writeData = Buffer.alloc(0);
		await this.file.append(newData);
	}
}

export async function fuseMount(FS: AnyFS, mountPoint: string, options?: AnyFSMountOptions, onDestroy?: () => void) {
	options = options ? { ...options } : {};
	const log = (options.verbose ?? false) ? console.log.bind(console) : ()=>{};
	const blockSize = options.reportedBlockSize ?? 512;
	const blockCount = options.reportedBlocks ?? (1024 * 1024);

	const root = await FS.root();

	// Used for silencing TypeScript errors related to
	// interface properties
	const nothing: any = {};

	let nextFd = 0;
	const openFiles = new Map<number, OpenFile>();

	const filesystem: fuse.MountOptions = {
		async getattr(path, callback: (code: number, stats?: fuse.Stats) => void) {
			log("getattr(%s)", path);
			try {
				const file = await FS.atPath(path);
				if (file == null) {
					callback(fuse.ENOENT);
					return;
				}
				const stats: fuse.Stats = {
					...nothing,
					mtime: new Date(0),
					atime: new Date(0),
					ctime: new Date(0),
					mode: 0o777,
					uid: process.getuid(),
					gid: process.getgid()
				};
				if (file instanceof AnyFSFolder) {
					stats.mode |= fs.constants.S_IFDIR;
					stats.nlink = 2;
					stats.size = 8;
				}
				else if (file instanceof AnyFSFile) {
					stats.mode |= fs.constants.S_IFREG;
					const realStats = await file.stat();
					stats.size = realStats.size;
					stats.nlink = 1;
				}
				else {
					callback(fuse.ENOENT);
					return;
				}
				callback(0, stats);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},

		async readdir(path, callback: (code: number, dirs: string[]) => void) {
			log("readdir(%s)", path);
			try {
				const file = await FS.atPath(path);
				if (file == null) {
					callback(fuse.ENOENT, []);
					return;
				}
				else if (!(file instanceof AnyFSFolder)) {
					callback(fuse.ENOTDIR, []);
					return;
				}
				const contents = await file.listContents();
				callback(0, contents.map((a) => a.name));
			}
			catch (err) {
				log(err);
				callback(fuse.EIO, []);
			}
		},

		async open(path, flags, callback: (code: number, fd: number) => void) {
			let fd = null;
			try {
				const file = await FS.atPath(path);
				if (file == null) {
					callback(fuse.ENOENT, -1);
					return;
				}
				else if (!(file instanceof AnyFSFile)) {
					callback(fuse.EISDIR, -1);
					return;
				}
				fd = nextFd++;
				const openFile = new OpenFile(file, path, flags, fd);
				openFiles.set(fd, openFile);
				callback(0, fd);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO, -1);
			}
			finally {
				log("open(%s, %d)" + ((fd != null) ? ` = ${fd}` : ""), path, flags);
			}
		},

		async mknod(path: string, mode: number, dev: number, callback: (code: number) => void) {
			log("mknod(%s, %d, %d)", path, mode, dev);
			try {
				if (!(mode & fs.constants.S_IFREG)) {
					callback(fuse.EPERM);
					return;
				}
				const parent = await root.parentForPath(path);
				await parent.createFile(AnyFSFolder.basename(path));
				callback(0);
			}
			catch (err) {
				log(err);
				if (err?.message === 'No such file or directory.') {
					callback(fuse.ENOENT);
				}
				else if (err?.message === 'File exists.') {
					callback(fuse.EEXIST);
				}
				else {
					callback(fuse.EIO);
				}
			}
		},

		async read(path, fd, buffer, length, position, callback: (bytesReadOrError: number) => void) {
			log("read(%s, %d, <buf>, %d, %d)", path, fd, length, position);
			if (!openFiles.has(fd)) {
				log(new Error("openFiles does not have fd: " + fd));
				callback(fuse.EIO);
				return;
			}
			try {
				const file = openFiles.get(fd);
				const data = await file.read(position, length);
				const copied = data.copy(buffer);
				callback(copied);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},

		async truncate(path: string, size: number, callback: (code: number) => void) {
			log("truncate(%s, %d)", path, size);
			try {
				const file = await root.atPath(path);
				if (file == null) {
					callback(fuse.ENOENT);
					return;
				}
				else if (!(file instanceof AnyFSFile)) {
					callback(fuse.EISDIR);
					return;
				}
				const contents = await file.readAll();
				await file.writeAll(contents.slice(0, size));
				callback(0);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},

		async release(path: string, fd: number, callback: (code: number) => void) {
			log("release(%s, %d)", path, fd);
			const openFile = openFiles.get(fd);
			if (openFile != null) {
				await openFile.flush();
			}
			openFiles.delete(fd);
			callback(0);
		},

		async rmdir(path: string, callback: (code: number) => void) {
			log("rmdir(%s)", path);
			try {
				const file = await FS.atPath(path);
				if (!(file instanceof AnyFSFolder)) {
					callback(fuse.ENOTDIR);
					return;
				}
				else if (file.objectID === root.objectID) {
					callback(fuse.EPERM);
					return;
				}
				const contents = await file.listContents();
				if (contents.length !== 0) {
					callback(fuse.ENOTEMPTY);
					return;
				}
				//@ts-ignore
				const parent: AnyFSFolder = file.parent;
				await parent.deleteEntry(file.name);
				callback(0);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},

		async unlink(path: string, callback: (code: number) => void) {
			log("unlink(%s)", path);
			try {
				const file = await FS.atPath(path);
				if (!(file instanceof AnyFSFile)) {
					callback(fuse.EISDIR);
					return;
				}
				//@ts-ignore
				const parent: AnyFSFolder = file.parent;
				await parent.deleteEntry(file.name);
				callback(0);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},

		async mkdir(path: string, mode: number, callback: (code: number) => void) {
			log("mkdir(%s, %d)", path, mode);
			try {
				const parent = await root.parentForPath(path);
				await parent.createFolder(AnyFSFolder.basename(path));
				callback(0);
			}
			catch (err) {
				log(err);
				if (err?.message === 'No such file or directory.') {
					callback(fuse.ENOENT);
				}
				else if (err?.message === 'File exists.') {
					callback(fuse.EEXIST);
				}
				else {
					callback(fuse.EIO);
				}
			}
		},

		async write(path: string, fd: number, data: Buffer, length: number, position: number, callback: (bytesWrittenOrError: number) => void) {
			log("write(%s, %d, <buf>, %d, %d)", path, fd, length, position);
			try {
				const file = openFiles.get(fd);
				await file.write(position, length, data);
				callback(data.length);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},
		
		async rename(source: string, dest: string, callback: (code: number) => void) {
			log("rename(%s, %s)", source, dest);
			try {
				const sourceFile = await root.atPath(source);
				//@ts-ignore
				const sourceDirectory: AnyFSFolder = sourceFile.parent;
				const sourceBasename = sourceFile.name;
				const targetDirectory = await root.parentForPath(dest);
				const targetBasename = AnyFSFolder.basename(dest);
				const type = (sourceFile instanceof AnyFSFile) ? "file" : "folder";
				await targetDirectory.link(targetBasename, type, sourceFile.objectID, true);
				await sourceDirectory.deleteEntry(sourceBasename, true);
				callback(0);
			}
			catch (err) {
				log(err);
				if (err.message === 'File exists.') {
					callback(fuse.EEXIST);
				}
				if (err.message === 'Is a directory.') {
					callback(fuse.EISDIR);
				}
				else if (err.message === 'No such file or directory.') {
					callback(fuse.ENOENT);
				}
				else {
					callback(fuse.EIO);
				}
			}
		},

		chmod(path: string, mode: number, callback: (code: number) => void) {
			callback(0);
		},

		setxattr(path: string, name: string, buffer: Buffer, length: number, offset: number, flags: number, callback: (code: number) => void) {
			callback(0);
		},

		listxattr(path: string, buffer: Buffer, length: number, callback: (code: number, reqBufSize: number) => void) {
			callback(0, 0);
		},

		getxattr(path: string, name: string, buffer: Buffer, length: number, offset: number, callback: (code: number) => void) {
			// ENOATTR
			callback(-93);
		},

		removexattr(path: string, name: string, callback: (code: number) => void) {
			callback(0);
		},

		statfs(path: string, callback: (code: number, fsStat: fuse.FSStat) => void) {
			callback(0, {
				...nothing,
				bsize: blockSize,
				blocks: blockCount,
				ffree: blockCount,
				bfree: blockCount,
				bavail: blockCount,
				namemax: 256
			})
		},

		destroy(callback: (code: number) => void) {
			callback(0);
			if (onDestroy != null) {
				onDestroy();
			}
		}
	}

	fuse.mount(mountPoint, filesystem, (err) => {
		if (err == null) {
			// Exit cleanly on interrupt
			const interruptSignals: NodeJS.Signals[] = [ "SIGINT" ];
			for (const signal of interruptSignals) {
				process.on(signal, (signal) => {
					log(`Received ${signal}, cleaning up...`);
					fuse.unmount(mountPoint, (err) => {
						if (err == null) {
							log(`Unmounted ${mountPoint}`);
							process.exit(0);
						}
						else {
							log(`Unmount failed: ${err}`);
							process.exit(1);
						}
					});
				});
			}
			
			log(`Mounted on ${mountPoint}`);
		}
		else {
			log(`Mount failed: ${err}`);
			throw err;
		}
	});
}