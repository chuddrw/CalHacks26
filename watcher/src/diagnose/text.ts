/** UTF-8 byte limits match the database's bounded diagnostic fields without splitting code points. */
export function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}
