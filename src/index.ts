import path from "path";
import { LocalFS, LocalFSAuth } from "./examples/local-fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { FtpSrv } from "ftp-srv";

export * from "./anyfs";

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
		const fileData = JSON.parse(readFileSync(authDataPath, 'utf-8'));
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
		writeFileSync(authDataPath, JSON.stringify(outputData));
	}
	const fs = LocalFS.authenticate(storagePath, authData);
	await fs.fuseMount(mountPath, { verbose: true }, () => {
		process.exit(0);
	});
	const ftpServer = new FtpSrv({
		anonymous: true,
		url: "http://127.0.0.1:2121",
		pasv_url: "http://127.0.0.1:2121"
	});
	ftpServer.on("login", async(loginData, resolve, reject) => {
		try {
			resolve({
				fs: await fs.getFTP(),
				cwd: "/"
			});
		}
		catch (err) {
			reject(err);	
		}
	});
	ftpServer.listen();
}

if (require.main === module) {
	main();
}