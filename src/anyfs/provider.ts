import { ObjectID } from "./internal-types";

export interface AnyFSProvider {
	/**
	 * Reads the entirety of the data for the given object ID
	 * and returns it. If the object ID is invalid, it will
	 * throw an exception.
	 * @param objectID Object ID.
	 * @returns Data for the object ID.
	 */
	readObject(objectID: ObjectID): Promise<Buffer>;

	/**
	 * Replaces the current data for the given object ID with
	 * the given data. `objectID` will always be an ID that was
	 * previously returned from `createObject()`. May throw
	 * an exception on failure.
	 * @param objectID Object ID.
	 * @param data New data.
	 */
	writeObject(objectID: ObjectID, data: Buffer): Promise<void>;

	/**
	 * Creates a new object. The data for this new object ID
	 * may be anything. This data is irrelevant because it will
	 * be immediately overwritten with a `writeObject()` call.
	 * 
	 * **Warning:** When implementing this function, never return
	 * the same object ID more than once. Doing so will cause
	 * filesystem corruption.
	 * @returns Object ID for the new object.
	 */
	createObject(): Promise<ObjectID>;

	/**
	 * Deletes an object if possible. This object ID will never
	 * be used again if deletion is successful.
	 * 
	 * **Warning:** Do not implement this function if you aren't
	 * able to delete objects. When deletion is impossible, AnyFS
	 * will reuse unused objects.
	 * @returns `true` if the deletion was successful, `false`
	 * otherwise.
	 */
	deleteObject?(objectID: ObjectID): Promise<boolean>;
}