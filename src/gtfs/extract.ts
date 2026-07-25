import { File } from 'expo-file-system';
import { unzipSync, strFromU8 } from 'fflate';

export type ZipContents = Record<string, string>; // filename → UTF-8 text

// Extract a ZIP archive from a file URI, returning only the .txt files
// as UTF-8 strings keyed by their lowercase base filename.
export async function extractGtfsZip(uri: string): Promise<ZipContents> {
  const file = new File(uri);
  const bytes = await file.bytes();

  const unzipped = unzipSync(bytes);

  const result: ZipContents = {};
  for (const [path, data] of Object.entries(unzipped)) {
    const name = (path.split('/').pop() ?? path).toLowerCase();
    if (name.endsWith('.txt') && data.length > 0) {
      result[name] = strFromU8(data);
    }
  }
  return result;
}
