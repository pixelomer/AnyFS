import { AnyFS } from "./anyfs";
import { AnyFSObject } from "./fs-object";
import { AnyFSDataMetadata, AnyFSFileMetadata, AnyFSFileStat, ObjectID } from "./internal-types";
import { AnyFSReader } from "./reader";
import { AnyFSWriter } from "./writer";

export class AnyFSFileChunk extends AnyFSObject {
	constructor(FS: AnyFS, parent: AnyFSObject, objectID: ObjectID) {
		super(FS, parent, null, objectID);
	}

	async updateData(newData: Buffer, writer?: AnyFSWriter) {
		let _writer: AnyFSWriter;
		if (writer == null) {
			_writer = await this.FS._getWrite();
			writer = _writer;
		}
		try {
			await writer.writeObject<AnyFSDataMetadata>(this.objectID, {
				metadata: { type: 'data' },
				data: newData
			});
		}
		finally {
			_writer?.release();
		}
	}

	static async create(FS: AnyFS, parent: AnyFSObject, writer: AnyFSWriter, data?: Buffer): Promise<AnyFSFileChunk> {
		const objectID = await writer.createObject();
		const chunk = new this(FS, parent, objectID);
		await chunk.updateData(data ?? Buffer.alloc(0), writer);
		return chunk;
	}
}