import path from "path";
import { LocalFS, LocalFSAuth } from "./examples/local-fs";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";

import { AnyFSProvider, AnyFS, AnyFSFile, AnyFSFolder, fuseMount } from "./anyfs";
export { AnyFSProvider, AnyFS, AnyFSFile, AnyFSFolder, fuseMount };

async function main() {
	if (process.argv.length < 4) {
		console.log("Usage:", path.basename(process.argv[1]), "<storage path> <mount path>");
		process.exit(1);
	}
	const storagePath = process.argv[2];
	const mountPath = process.argv[3];
	if (!existsSync(storagePath)) {
		mkdirSync(storagePath);
	}
	const authDataPath = path.join(storagePath, "auth.json");
	let authData: LocalFSAuth;
	if (existsSync(authDataPath)) {
		const fileData = JSON.parse(await readFile(authDataPath, 'utf-8'));
		authData = {
			key: Buffer.from(fileData.key, 'base64'),
			root: fileData.root
		};
	}
	else {
		authData = await LocalFS.createKey(storagePath);
		const outputData = {
			key: authData.key.toString('base64'),
			root: authData.root
		};
		await writeFile(authDataPath, JSON.stringify(outputData));
	}
	const fs = LocalFS.authenticate(storagePath, authData);
	await fuseMount(fs, mountPath, { verbose: true }, () => {
		process.exit(0);
	});
}

if (require.main === module) {
	main();
}