import { AnyFS } from "./anyfs";

export async function getFTP(FS: AnyFS): Promise<any> {
	let ftp;
	try {
		ftp = require('./_ftp');
	}
	catch {
		throw new Error("The ftp-srv package is missing.");
	}
	return ftp.getFTP(FS);
}