export type ObjectID = any;

export interface AnyFSMetadata {
	type: string,
	xattr?: any
}

export interface AnyFSDataMetadata extends AnyFSMetadata {
	type: "data"
}

export interface AnyFSFileStat {
	size: number
}

export interface AnyFSFileMetadata extends AnyFSMetadata, AnyFSFileStat {
	type: "file",
	chunks: ObjectID[]
}

export interface AnyFSFolderEntry {
	name: string,
	type: "file" | "folder",
	objectID: ObjectID
}

export interface AnyFSFolderMetadata extends AnyFSMetadata {
	type: "folder",
	entries: AnyFSFolderEntry[]
}

export interface AnyFSObjectRaw<T> {
	metadata: T,
	data: Buffer | null
}