import { base64ToBytes } from 'places-shared/utils';

const FIT_SIGNATURE = [0x2e, 0x46, 0x49, 0x54];
const FIT_HEADER_SIZES = [12, 14];
const FIT_HEADER_BYTES = 14;

const FIT_HEADER_BASE64_CHARS = 24;

export function isFitBytes(bytes: Uint8Array): boolean {
  if (bytes.length < FIT_HEADER_BYTES) return false;

  return FIT_HEADER_SIZES.includes(bytes[0]) && FIT_SIGNATURE.every((byte, index) => bytes[8 + index] === byte);
}

export function isFitBase64(content: string): boolean {
  if (content.length < FIT_HEADER_BASE64_CHARS) return false;
  const header = content.slice(0, FIT_HEADER_BASE64_CHARS);

  if (!/^[A-Za-z0-9+/]+$/.test(header)) return false;

  try {
    return isFitBytes(base64ToBytes(header));
  } catch {
    return false;
  }
}
