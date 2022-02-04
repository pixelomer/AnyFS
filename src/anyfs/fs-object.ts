import { AnyFS } from "./anyfs";
import { AnyFSFileChunk } from "./fs-chunk";
import { AnyFSFile } from "./fs-file";
import { AnyFSFolder } from "./fs-folder";
import { ObjectID } from "./internal-types";

export class AnyFSObject {
	FS: AnyFS;
	objectID: ObjectID;
	parent: AnyFSObject;
	name: string;

	constructor(FS: AnyFS, parent: AnyFSObject, name: string, objectID: ObjectID) {
		this.FS = FS;
		this.objectID = objectID;
		this.parent = parent ?? this;
		this.name = name;
	}

	isFile(): this is AnyFSFile {
		return false;
	}

	isFolder(): this is AnyFSFolder {
		return false;
	}

	isFileChunk(): this is AnyFSFileChunk {
		return false;
	}
}