import { AnyFS } from "./anyfs";
import { AnyFSFileChunk } from "./fs-chunk";
import { AnyFSObject } from "./fs-object";
import { AnyFSDataMetadata, AnyFSFileMetadata, AnyFSFileStat } from "./internal-types";
import { AnyFSReader } from "./reader";
import { AnyFSWriter } from "./writer";

export class AnyFSFile extends AnyFSObject {
	isFile() {
		return true;
	}

	static async create(FS: AnyFS, parent: AnyFSObject, name: string): Promise<AnyFSFile> {
		const writer = await FS._getWrite();
		try {
			const objectID = await writer.createObject();
			await writer.writeObject<AnyFSFileMetadata>(objectID, {
				metadata: {
					type: "file",
					chunks: [],
					size: 0
				},
				data: null
			});
			return new this(FS, parent, name, objectID);
		}
		finally {
			writer.release();
		}
	}

	async readAll(): Promise<Buffer> {
		const reader = await this.FS._getRead();
		try {
			const metadata = (await reader.readObject<AnyFSFileMetadata>(this.objectID)).metadata;
			return await this._read(reader, 0, metadata.size);
		}
		finally {
			reader.release();
		}
	}

	private async _read(reader: AnyFSReader, position: number, length: number): Promise<Buffer> {
		if ((position < 0) || (length < 0)) {
			throw new Error("Attempted to read with negative values.");
		}
		const metadata = (await reader.readObject<AnyFSFileMetadata>(this.objectID)).metadata;
		if ((position + length) > metadata.size) {
			length = metadata.size - position;
		}
		if ((position < 0) || (length <= 0)) {
			return Buffer.alloc(0);
		}
		const firstChunkIndex = Math.floor(position / this.FS.chunkSize);
		const lastChunkIndex = Math.floor((position + length) / this.FS.chunkSize);
		const initialBufferSize = (lastChunkIndex - firstChunkIndex + 1) * this.FS.chunkSize;
		const data = Buffer.allocUnsafe(initialBufferSize);
		let copiedLength = 0;
		for (let i=firstChunkIndex; i<=lastChunkIndex; i++) {
			const chunkID = metadata.chunks[i];
			if (chunkID == null) {
				break;
			}
			const chunk = await reader.readObject(chunkID);
			copiedLength += chunk.data.copy(
				data,
				(i - firstChunkIndex) * this.FS.chunkSize,
				0,
				this.FS.chunkSize
			);
		}
		data.fill(0, copiedLength);
		const requestedDataStart = position - (firstChunkIndex * this.FS.chunkSize);
		const requestedData = Buffer.from(data.slice(requestedDataStart, requestedDataStart + length));
		return requestedData;
	}

	async read(position: number, length: number): Promise<Buffer> {
		const reader = await this.FS._getRead();
		try {
			return await this._read(reader, position, length);
		}
		finally {
			reader.release();
		}
	}

	async truncate(): Promise<void> {
		const writer = await this.FS._getWrite();
		try {
			const metadata = (await writer.readObject<AnyFSFileMetadata>(this.objectID)).metadata;
			for (const chunk of metadata.chunks) {
				await writer.deleteObject(chunk);
			}
			await writer.writeObject<AnyFSFileMetadata>(this.objectID, {
				metadata: {
					type: "file",
					chunks: [],
					size: 0
				},
				data: null
			});
		}
		finally {
			writer.release();
		}
	}

	async append(data: Buffer): Promise<void> {
		const writer = await this.FS._getWrite();
		try {
			const metadata = (await writer.readObject<AnyFSFileMetadata>(this.objectID)).metadata;
			let startIndex: number;
			let newData: Buffer;
			if (metadata.chunks.length > 0) {
				startIndex = metadata.chunks.length - 1;
				const lastChunk = metadata.chunks[startIndex];
				const lastChunkData = (await writer.readObject(lastChunk)).data;
				newData = Buffer.concat([lastChunkData, data]);
			}
			else {
				startIndex = 0;
				newData = data;
			}
			await this._write(writer, startIndex, newData);
		}
		finally {
			writer.release();
		}
	}

	async writeAll(newData: Buffer): Promise<void> {
		const writer = await this.FS._getWrite();
		try {
			await this._write(writer, 0, newData);
		}
		finally {
			writer.release();
		}
	}

	private async _write(writer: AnyFSWriter, startIndex: number, newData: Buffer): Promise<void> {
		const metadata = (await writer.readObject<AnyFSFileMetadata>(this.objectID)).metadata;

		// Reuse existing data objects
		const chunks = metadata.chunks;

		// Create new data objects and modify existing ones
		let i: number, seek: number;
		for (i=startIndex, seek=0; seek<newData.length; i+=1, seek+=this.FS.chunkSize) {
			let chunk: AnyFSFileChunk;
			const chunkData = newData.slice(seek, seek + this.FS.chunkSize);
			if (chunks[i] == null) {
				chunk = await AnyFSFileChunk.create(this.FS, this, writer, chunkData);
				chunks[i] = chunk.objectID;
			}
			else {
				chunk = new AnyFSFileChunk(this.FS, this, chunks[i]);
				await chunk.updateData(chunkData);
			}
		}
		chunks.splice(i);

		// Save the new metadata
		await writer.writeObject<AnyFSFileMetadata>(this.objectID, {
			metadata: {
				type: "file",
				chunks: chunks,
				size: (startIndex * this.FS.chunkSize) + newData.length
			},
			data: null
		});
	}

	async stat(): Promise<AnyFSFileStat> {
		const reader = await this.FS._getRead();
		try {
			const metadata = (await reader.readObject<AnyFSFileMetadata>(this.objectID)).metadata;
			return {
				size: metadata.size
			};
		}
		finally {
			reader.release();
		}
	}
}