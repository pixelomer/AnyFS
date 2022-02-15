import { AnyFS } from "./anyfs";

export interface AnyFSMountOptions {
	verbose?: boolean,
	reportedBlocks?: number,
	reportedBlockSize?: number,
	allowWrite?: boolean
}

export async function fuseMount(FS: AnyFS, mountPoint: string, options?: AnyFSMountOptions, onDestroy?: () => void) {
	let fuse: any;
	try {
		fuse = require("./_fuse");
	}
	catch {
		throw new Error("The fuse-bindings package is missing.");
	}
	return fuse.fuseMount(FS, mountPoint, options, onDestroy);
}