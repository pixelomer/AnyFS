import { AnyFS } from "./anyfs";

export interface AnyFSMountOptions {
	verbose?: boolean,
	reportedBlocks?: number,
	reportedBlockSize?: number
}

export async function fuseMount(FS: AnyFS, mountPoint: string, options?: AnyFSMountOptions, onDestroy?: () => void) {
	try {
		const fuse = require("./_fuse");
		return fuse.fuseMount(FS, mountPoint, options, onDestroy);
	}
	catch {
		throw new Error("The fuse-bindings package is missing.");
	}
}