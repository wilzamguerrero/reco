/**
 * Almacenamiento local de archivos grandes en OPFS (Origin Private File System).
 * Permite grabar videos largos sin saturar la memoria RAM del proceso.
 */

export async function createOpfsWriter(fileName: string): Promise<{
  write: (chunk: Blob) => Promise<void>;
  close: () => Promise<number>;
  abort: () => Promise<void>;
}> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  let totalBytes = 0;

  return {
    async write(chunk: Blob) {
      const buf = await chunk.arrayBuffer();
      totalBytes += buf.byteLength;
      await writable.write(buf);
    },
    async close() {
      await writable.close();
      return totalBytes;
    },
    async abort() {
      try {
        await writable.abort();
      } catch {
        // ignore
      }
      try {
        await root.removeEntry(fileName);
      } catch {
        // ignore
      }
    },
  };
}

export async function readOpfsFile(fileName: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteOpfsFile(fileName: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName);
  } catch {
    // ignore
  }
}
