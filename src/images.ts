/** Source image formats accepted for local publication. Never infer from the URL. */
export function imageExtension(bytes: Buffer): string {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "jpg";
  const text = (start: number, end: number) =>
    bytes.toString("ascii", start, end);
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(text(0, 6)))
    return "gif";
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP")
    return "webp";
  if (
    bytes.length >= 12 &&
    text(4, 8) === "ftyp" &&
    ["avif", "avis"].includes(text(8, 12))
  )
    return "avif";
  return "";
}
