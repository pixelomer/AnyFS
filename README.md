# AnyFS

A simple filesystem which stores metadata using JSON. Made with the goal of simplifying the creation of filesystems on places that are generally not supposed to store files.

## Usage

The smallest unit of storage in AnyFS is called an object. Each object stores JSON data, and optionally a null byte followed by binary data. Object data is encrypted with AES-256. Each object has a unique ID which can either be a number or a string.

Each AnyFS filesystem has a data provider. This data provider is responsible for creating, reading, updating and deleting objects, and nothing else. The only job of a data provider is storing and retrieving binary data. It does not need to (and should not try to) decrypt or parse this data.

You can create your own AnyFS filesystem by implementing your own AnyFS data provider. The functions you need to implement are `createObject()`, `writeObject(objectID, data)` and `readObject(objectID)`. `deleteObject(objectID)` is optional and filesystem functionality will not be affected if it is missing, but it is highly recommended that you implement it if possible.

## Functionality

AnyFS provides a FUSE filesystem and an FTP server for accessing filesystems. You may also use the  `AnyFS` class in your code to access files programmatically. However, in its current state, the `AnyFS` class only contains very low level functions and may be hard to use. This is planned to be fixed in future versions.

The FTP implementation does not have any known issues. However, the FUSE implementation is known to corrupt data on write, so it is recommended that you only use it in read-only mode. This may be an issue with AnyFS or node-fuse-bindings but the culprit is not known at this time.

## LocalFS Usage

AnyFS comes with LocalFS, an AnyFS data provider that stores AnyFS data in the local filesystem. This is useful for debugging purposes but not for much else. You can mount a LocalFS filesystem with the following command.

```bash
npm start /path/to/storage /path/to/mnt
```

This will mount a LocalFS filesystem at `/path/to/mnt` using the data in `/path/to/storage`. If the data does not exist, it will initialize a new filesystem.