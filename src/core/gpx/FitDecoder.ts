import { isFitBytes } from '../overlay/FitSignature';

export type FitFieldValue = number | string | number[];

export interface FitMessage {
  globalMessageNumber: number;
  fields: Map<number, FitFieldValue>;
}

const RECORD_HEADER_COMPRESSED = 0x80;
const RECORD_HEADER_DEFINITION = 0x40;
const RECORD_HEADER_DEVELOPER_DATA = 0x20;
const COMPRESSED_TIMESTAMP_MASK = 0x1f;
const TIMESTAMP_FIELD = 253;

interface FitFieldDefinition {
  fieldNumber: number;
  size: number;
  baseType: number;
}

interface FitMessageDefinition {
  globalMessageNumber: number;
  littleEndian: boolean;
  fields: FitFieldDefinition[];
  totalSize: number;
}

const BASE_TYPE_SIZES = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];

const STRING_BASE_TYPE = 7;

const textDecoder = new TextDecoder();

export function decodeFitMessages(bytes: Uint8Array): FitMessage[] {
  if (!isFitBytes(bytes)) {
    throw new Error('Not a FIT file: missing .FIT header signature.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: FitMessage[] = [];
  let offset = 0;

  while (offset + 14 <= bytes.length && isFitBytes(bytes.subarray(offset))) {
    const headerSize = view.getUint8(offset);
    const dataSize = view.getUint32(offset + 4, true);
    const dataEnd = Math.min(offset + headerSize + dataSize, bytes.length);

    decodeRecords(view, offset + headerSize, dataEnd, messages);
    offset = dataEnd + 2;
  }

  if (messages.length === 0) {
    throw new Error('FIT file contains no messages.');
  }

  return messages;
}

function decodeRecords(view: DataView, start: number, end: number, messages: FitMessage[]): void {
  const definitions = new Map<number, FitMessageDefinition>();
  let offset = start;
  let lastTimestamp = 0;

  while (offset < end) {
    const recordHeader = view.getUint8(offset);

    offset += 1;

    if ((recordHeader & RECORD_HEADER_COMPRESSED) !== 0) {
      const definition = definitions.get((recordHeader >> 5) & 0x03);

      if (!definition) return;
      if (offset + definition.totalSize > end) return;
      const message = readDataMessage(view, offset, definition);

      lastTimestamp = expandCompressedTimestamp(recordHeader & COMPRESSED_TIMESTAMP_MASK, lastTimestamp);
      message.fields.set(TIMESTAMP_FIELD, lastTimestamp);
      messages.push(message);
      offset += definition.totalSize;
      continue;
    }

    if ((recordHeader & RECORD_HEADER_DEFINITION) !== 0) {
      const read = readDefinitionMessage(view, offset, end, (recordHeader & RECORD_HEADER_DEVELOPER_DATA) !== 0);

      if (!read) return;
      definitions.set(recordHeader & 0x0f, read.definition);
      offset = read.offset;
      continue;
    }

    const definition = definitions.get(recordHeader & 0x0f);

    if (!definition) return;
    if (offset + definition.totalSize > end) return;
    const message = readDataMessage(view, offset, definition);
    const timestamp = message.fields.get(TIMESTAMP_FIELD);

    if (typeof timestamp === 'number') lastTimestamp = timestamp;
    messages.push(message);
    offset += definition.totalSize;
  }
}

// The 5-bit offset in a compressed header counts seconds from the last full
// timestamp and rolls over every 32 seconds.
function expandCompressedTimestamp(offset: number, lastTimestamp: number): number {
  const base = lastTimestamp & ~COMPRESSED_TIMESTAMP_MASK;
  const previousOffset = lastTimestamp & COMPRESSED_TIMESTAMP_MASK;

  return offset >= previousOffset ? base + offset : base + offset + 0x20;
}

function readDefinitionMessage(view: DataView, start: number, end: number, hasDeveloperData: boolean): { definition: FitMessageDefinition; offset: number } | null {
  let offset = start + 1;

  if (offset + 4 > end) return null;

  const littleEndian = view.getUint8(offset) === 0;

  offset += 1;
  const globalMessageNumber = view.getUint16(offset, littleEndian);

  offset += 2;
  const fieldCount = view.getUint8(offset);

  offset += 1;
  if (offset + fieldCount * 3 > end) return null;

  const fields: FitFieldDefinition[] = [];
  let totalSize = 0;

  for (let index = 0; index < fieldCount; index++) {
    const fieldNumber = view.getUint8(offset);
    const size = view.getUint8(offset + 1);
    const baseType = view.getUint8(offset + 2);

    fields.push({ fieldNumber, size, baseType });
    totalSize += size;
    offset += 3;
  }

  if (hasDeveloperData) {
    if (offset >= end) return null;
    const developerFieldCount = view.getUint8(offset);

    offset += 1;
    if (offset + developerFieldCount * 3 > end) return null;

    for (let index = 0; index < developerFieldCount; index++) {
      totalSize += view.getUint8(offset + 1);
      offset += 3;
    }
  }

  return { definition: { globalMessageNumber, littleEndian, fields, totalSize }, offset };
}

function readDataMessage(view: DataView, start: number, definition: FitMessageDefinition): FitMessage {
  const fields = new Map<number, FitFieldValue>();
  let offset = start;

  for (const field of definition.fields) {
    const value = readField(view, offset, field, definition.littleEndian);

    if (value !== undefined) fields.set(field.fieldNumber, value);
    offset += field.size;
  }

  return { globalMessageNumber: definition.globalMessageNumber, fields };
}

function readField(view: DataView, offset: number, field: FitFieldDefinition, littleEndian: boolean): FitFieldValue | undefined {
  const baseType = field.baseType & 0x1f;

  if (baseType === STRING_BASE_TYPE) {
    return readString(view, offset, field.size);
  }

  const elementSize = BASE_TYPE_SIZES[baseType];

  if (elementSize === undefined || field.size < elementSize) return undefined;

  const count = Math.floor(field.size / elementSize);

  if (count === 1) {
    const value = readScalar(view, offset, baseType, littleEndian);

    return isInvalid(value, baseType) ? undefined : value;
  }

  const values: number[] = [];

  for (let index = 0; index < count; index++) {
    const value = readScalar(view, offset + index * elementSize, baseType, littleEndian);

    if (!isInvalid(value, baseType)) values.push(value);
  }

  return values.length > 0 ? values : undefined;
}

function readString(view: DataView, offset: number, size: number): string | undefined {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, size);
  const terminator = bytes.indexOf(0);
  const text = textDecoder.decode(terminator === -1 ? bytes : bytes.subarray(0, terminator)).trim();

  return text || undefined;
}

function readScalar(view: DataView, offset: number, baseType: number, littleEndian: boolean): number {
  switch (baseType) {
    case 0: case 2: case 10: case 13: return view.getUint8(offset);
    case 1: return view.getInt8(offset);
    case 3: return view.getInt16(offset, littleEndian);
    case 4: case 11: return view.getUint16(offset, littleEndian);
    case 5: return view.getInt32(offset, littleEndian);
    case 6: case 12: return view.getUint32(offset, littleEndian);
    case 8: return view.getFloat32(offset, littleEndian);
    case 9: return view.getFloat64(offset, littleEndian);
    case 14: return Number(view.getBigInt64(offset, littleEndian));
    case 15: case 16: return Number(view.getBigUint64(offset, littleEndian));
    default: return view.getUint8(offset);
  }
}

// Each base type reserves one value to mean "not set". Signed types use their
// maximum, unsigned types all-bits-set, and the z types zero.
function isInvalid(value: number, baseType: number): boolean {
  switch (baseType) {
    case 0: case 2: case 13: return value === 0xff;
    case 1: return value === 0x7f;
    case 3: return value === 0x7fff;
    case 4: return value === 0xffff;
    case 5: return value === 0x7fffffff;
    case 6: return value === 0xffffffff;
    case 8: case 9: return Number.isNaN(value);
    case 10: case 11: case 12: case 16: return value === 0;
    case 14: return value === 2 ** 63;
    case 15: return value === 2 ** 64;
    default: return false;
  }
}
