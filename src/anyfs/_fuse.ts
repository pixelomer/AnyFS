import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import util from "util";
import { AnyFSFile } from "./fs-file";
import { AnyFS } from "./anyfs";
import { AnyFSFolder } from "./fs-folder";
import { AnyFSMountOptions } from "./fuse";
//@ts-ignore
import fuse from "fuse-bindings";

class OpenFile {
	path: string
	fd: number
	file: AnyFSFile
	flags: number
	tmpdir: string
	previousWrite: {
		position: number,
		data: Buffer
	}

	private _IOLock: Promise<void>;
	private _writeLock: Promise<void>;
	private _localFilePath: string;
	private _localFileHandle: fs.promises.FileHandle;
	private _closed: boolean;

	constructor(file: AnyFSFile, path: string, flags: number, fd: number, tmpdir: string) {
		this.fd = fd;
		this.path = path;
		this.file = file;
		this.flags = flags;
		this.tmpdir = tmpdir;
	}

	private async _canPerformIO() {
		await this._IOLock;
		if (this._closed) {
			throw new Error("Attempted to perform I/O on a closed file.")
		}
	}

	private async _cleanup() {
		if (this._localFileHandle != null) {
			try { await this._localFileHandle.close() }
			catch {}
			this._localFileHandle = null;
		}
		if (this._localFilePath != null) {
			try { fs.unlinkSync(this._localFilePath); }
			catch {}
			this._localFilePath = null;
		}
	}

	async close() {
		await this._IOLock;
		this._closed = true;
		if (this._localFileHandle != null) {
			await this._localFileHandle.close();
			const fileData = await fs.promises.readFile(this._localFilePath);
			await this.file.writeAll(fileData);
		}
		await this._cleanup();
	}

	async write(data: Buffer, position: number): Promise<number> {
		await this._canPerformIO();
		if (this._localFileHandle == null) {
			// Lock I/O until the download is finished
			let unlockIO: () => void;
			this._IOLock = new Promise((resolve) => {
				unlockIO = resolve;
			});

			try {
				// Download the whole file
				const objectIDHash = crypto
					.createHash('sha256')
					.update(this.file.objectID.toString())
					.digest('hex')
					+ `_${this.fd.toString()}`;
				this._localFilePath = path.join(this.tmpdir, objectIDHash);
				const writeStream = fs.createWriteStream(this._localFilePath);
				try {
					await this.file.readAll(async(chunk, index, total) => {
						await util.promisify(writeStream.write.bind(writeStream))(chunk);
					});
				}
				finally {
					await util.promisify(writeStream.end.bind(writeStream))();
					await util.promisify(writeStream.close.bind(writeStream))();
				}
				this._localFileHandle = await fs.promises.open(this._localFilePath, "r+");
			}
			catch (err) {
				// Something went wrong, delete the file and rethrow
				await this._cleanup();
				throw err;
			}
			finally {
				// Unlock I/O
				unlockIO();
			}
		}
	
		await this._writeLock;
		let unlockWrite: () => void;
		this._writeLock = new Promise((resolve) => {
			unlockWrite = resolve;
		});
		let bytesWritten: number;
		try {
			/*console.log("Writing data", {
				data: data,
				plaintextData: data.toString('utf-8'),
				offset: 0,
				length: data.length,
				positon: position
			})*/
			const result = await this._localFileHandle.write(data, 0, data.length, position);
			//await this._localFileHandle.sync();
			this.previousWrite = { data, position };
			bytesWritten = result.bytesWritten;
		}
		finally {
			unlockWrite();
		}
		return bytesWritten;
	}

	async read(position: number, length: number): Promise<Buffer> {
		await this._canPerformIO()
		if (this._localFileHandle != null) {
			const buffer = Buffer.allocUnsafe(length);
			const result = await this._localFileHandle.read(buffer, 0, length, position);
			const finalBuffer = Buffer.allocUnsafe(result.bytesRead);
			result.buffer.copy(finalBuffer);
			return finalBuffer;
		}
		else {
			return await this.file.read(position, length);
		}
	}
}

export async function fuseMount(FS: AnyFS, mountPoint: string, options?: AnyFSMountOptions, onDestroy?: () => void) {
	mountPoint = fs.realpathSync(mountPoint);
	options = options ? { ...options } : {};
	const log = (options.verbose ?? false) ? console.log.bind(console) : ()=>{};
	const isReadonly = options.allowWrite ? !options.allowWrite : true;
	const blockSize = options.reportedBlockSize ?? 512;
	const blockCount = options.reportedBlocks ?? (1024 * 1024);

	const root = await FS.root();

	const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "anyfs"));

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
				const openFile = new OpenFile(file, path, flags, fd, tmpdir);
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
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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
			try {
				if (!openFiles.has(fd)) {
					throw new Error("openFiles does not have fd: " + fd);
				}
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
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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
				if (contents.length > size) {
					await file.writeAll(contents.slice(0, size));
				}
				else if (contents.length < size) {
					//FIXME: This is a waste of RAM
					const buffer = Buffer.alloc(size - contents.length);
					await file.append(buffer);
				}
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
				await openFile.close();
			}
			openFiles.delete(fd);
			callback(0);
		},

		async rmdir(path: string, callback: (code: number) => void) {
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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

		async access(path: string, mode: number, callback: (code: number) => void) {
			// access() is called a lot
			//log("access(%s, %d)", path, mode);
			try {
				const file = await root.atPath(path);
				if (file == null) {
					callback(fuse.ENOENT);
					return;
				}
				if (isReadonly && (mode & fs.constants.W_OK)) {
					callback(fuse.EROFS);
				}
				else {
					callback(0);
				}
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},

		async unlink(path: string, callback: (code: number) => void) {
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
			log("write(%s, %d, <buf: %d>, %d, %d)", path, fd, data.length, length, position);
			try {
				const file = openFiles.get(fd);
				const copiedData = Buffer.alloc(data.length);
				data.copy(copiedData);
				const writtenBytes = await file.write(copiedData, position);
				callback(writtenBytes);
			}
			catch (err) {
				log(err);
				callback(fuse.EIO);
			}
		},
		
		async rename(source: string, dest: string, callback: (code: number) => void) {
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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
			if (isReadonly) {
				callback(fuse.EROFS);
				return;
			}
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