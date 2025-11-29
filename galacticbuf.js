const VERSION_V1 = 0x01;
const VERSION_V2 = 0x02;

const TYPE_INT = 0x01;
const TYPE_STRING = 0x02;
const TYPE_LIST = 0x03;
const TYPE_OBJECT = 0x04;
const TYPE_BYTES = 0x05;

class GalacticList {
    constructor(elementType, items) {
        this.__galactic_list = true;
        this.elementType = elementType; // 'int' | 'string' | 'object'
        this.items = items || [];
    }
}

function listOfInts(items) {
    return new GalacticList('int', items);
}

function listOfStrings(items) {
    return new GalacticList('string', items);
}

function listOfObjects(items) {
    return new GalacticList('object', items);
}

// Helper for bytes type (v2)
function bytes(data) {
    let buf;
    if (Buffer.isBuffer(data)) {
        buf = data;
    } else if (data instanceof Uint8Array) {
        buf = Buffer.from(data);
    } else if (typeof data === 'string') {
        buf = Buffer.from(data, 'utf8');
    } else {
        throw new Error('Unsupported bytes value type');
    }
    return { __galactic_bytes: true, data: buf };
}

// ----------------- ENCODING -----------------

function encodeMessage(obj, version = VERSION_V2) {
    if (version !== VERSION_V1 && version !== VERSION_V2) {
        throw new Error(`Unsupported GalacticBuf version for encoding: ${version}`);
    }

    const fieldCount = countFields(obj);
    const fieldsBuf = encodeFields(obj, version);
    const headerLength = version === VERSION_V1 ? 4 : 6;
    const totalLength = headerLength + fieldsBuf.length;

    if (version === VERSION_V1 && totalLength > 0xffff) {
        throw new Error('Message too long for GalacticBuf v1 (max 65535 bytes)');
    }
    if (version === VERSION_V2 && totalLength > 0xffffffff) {
        throw new Error('Message too long for GalacticBuf v2 (max 4GB)');
    }

    const header = Buffer.alloc(headerLength);
    header.writeUInt8(version, 0);
    header.writeUInt8(fieldCount, 1);
    if (version === VERSION_V1) {
        header.writeUInt16BE(totalLength, 2);
    } else {
        header.writeUInt32BE(totalLength, 2);
    }

    return Buffer.concat([header, fieldsBuf]);
}

function countFields(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    return Object.entries(obj).reduce((count, [_, value]) => {
        if (value === undefined || value === null) return count;
        return count + 1;
    }, 0);
}

function encodeFields(obj, version) {
    const buffers = [];
    if (!obj || typeof obj !== 'object') return Buffer.alloc(0);

    for (const [name, value] of Object.entries(obj)) {
        if (value === undefined || value === null) continue;

        const nameBuf = Buffer.from(name, 'utf8');
        if (nameBuf.length === 0 || nameBuf.length > 255) {
            throw new Error(`Invalid field name length for "${name}"`);
        }

        // Field name length + name + type
        const fieldHeader = Buffer.alloc(1 + nameBuf.length + 1);
        fieldHeader.writeUInt8(nameBuf.length, 0);
        nameBuf.copy(fieldHeader, 1);
        let typeCode;
        let valueBuf;

        if (value && value.__galactic_list) {
            typeCode = TYPE_LIST;
            valueBuf = encodeList(value, version);
        } else if (value && value.__galactic_bytes) {
            typeCode = TYPE_BYTES;
            valueBuf = encodeBytes(value.data, version);
        } else if (typeof value === 'number' || typeof value === 'bigint') {
            typeCode = TYPE_INT;
            valueBuf = encodeInt(value);
        } else if (typeof value === 'string') {
            typeCode = TYPE_STRING;
            valueBuf = encodeString(value, version);
        } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            typeCode = TYPE_BYTES;
            valueBuf = encodeBytes(value, version);
        } else if (value && typeof value === 'object') {
            typeCode = TYPE_OBJECT;
            valueBuf = encodeObject(value, version);
        } else {
            throw new Error(`Unsupported value type for field "${name}"`);
        }

        fieldHeader.writeUInt8(typeCode, 1 + nameBuf.length);
        buffers.push(fieldHeader, valueBuf);
    }

    if (buffers.length === 0) {
        return Buffer.alloc(0);
    }
    return Buffer.concat(buffers);
}

function encodeInt(val) {
    let big;
    if (typeof val === 'bigint') {
        big = val;
    } else {
        if (!Number.isInteger(val)) {
            throw new Error('Integer field must be an integer');
        }
        big = BigInt(val);
    }
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(big, 0);
    return buf;
}

function encodeString(str, version) {
    const data = Buffer.from(str, 'utf8');
    if (version === VERSION_V1 && data.length > 0xffff) {
        throw new Error('String too long for GalacticBuf v1');
    }
    if (version === VERSION_V2 && data.length > 0xffffffff) {
        throw new Error('String too long for GalacticBuf v2');
    }

    const lenBytes = version === VERSION_V1 ? 2 : 4;
    const buf = Buffer.alloc(lenBytes + data.length);
    if (version === VERSION_V1) {
        buf.writeUInt16BE(data.length, 0);
    } else {
        buf.writeUInt32BE(data.length, 0);
    }
    data.copy(buf, lenBytes);
    return buf;
}

function encodeBytes(data, version) {
    // bytes type is defined in v2; we always use 4-byte length
    const bufData = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bufData.length > 0xffffffff) {
        throw new Error('Bytes too long for GalacticBuf v2');
    }
    const buf = Buffer.alloc(4 + bufData.length);
    buf.writeUInt32BE(bufData.length, 0);
    bufData.copy(buf, 4);
    return buf;
}

function encodeList(listWrapper, version) {
    const items = listWrapper.items || [];
    let elementTypeCode;
    switch (listWrapper.elementType) {
        case 'int':
            elementTypeCode = TYPE_INT;
            break;
        case 'string':
            elementTypeCode = TYPE_STRING;
            break;
        case 'object':
            elementTypeCode = TYPE_OBJECT;
            break;
        default:
            throw new Error(`Unknown list element type: ${listWrapper.elementType}`);
    }

    if (version === VERSION_V1 && items.length > 0xffff) {
        throw new Error('Too many list elements for GalacticBuf v1');
    }
    if (version === VERSION_V2 && items.length > 0xffffffff) {
        throw new Error('Too many list elements for GalacticBuf v2');
    }

    const countBytes = version === VERSION_V1 ? 2 : 4;
    const header = Buffer.alloc(1 + countBytes);
    header.writeUInt8(elementTypeCode, 0);
    if (version === VERSION_V1) {
        header.writeUInt16BE(items.length, 1);
    } else {
        header.writeUInt32BE(items.length, 1);
    }

    const buffers = [header];

    for (const item of items) {
        if (elementTypeCode === TYPE_INT) {
            buffers.push(encodeInt(item));
        } else if (elementTypeCode === TYPE_STRING) {
            buffers.push(encodeString(item, version));
        } else if (elementTypeCode === TYPE_OBJECT) {
            buffers.push(encodeObject(item, version));
        }
    }

    return Buffer.concat(buffers);
}

function encodeObject(obj, version) {
    const fieldCount = countFields(obj);
    const fieldsBuf = encodeFields(obj, version);
    const header = Buffer.alloc(1);
    header.writeUInt8(fieldCount, 0);
    return Buffer.concat([header, fieldsBuf]);
}

// ----------------- DECODING -----------------

function decodeMessage(buf) {
    if (!Buffer.isBuffer(buf)) {
        throw new Error('Expected Buffer for GalacticBuf message');
    }
    if (buf.length < 4) {
        throw new Error('Buffer too short for GalacticBuf header');
    }

    const version = buf.readUInt8(0);
    if (version !== VERSION_V1 && version !== VERSION_V2) {
        throw new Error(`Unsupported GalacticBuf version: ${version}`);
    }

    const fieldCount = buf.readUInt8(1);
    let totalLength;
    let headerLength;
    if (version === VERSION_V1) {
        if (buf.length < 4) throw new Error('Buffer too short for v1 header');
        totalLength = buf.readUInt16BE(2);
        headerLength = 4;
    } else {
        if (buf.length < 6) throw new Error('Buffer too short for v2 header');
        totalLength = buf.readUInt32BE(2);
        headerLength = 6;
    }

    if (totalLength !== buf.length) {
        throw new Error('Total length in header does not match buffer length');
    }

    const [obj, offset] = decodeFields(fieldCount, buf, headerLength, version);
    if (offset !== buf.length) {
        throw new Error('Extra bytes after GalacticBuf message');
    }
    return obj;
}

function decodeFields(fieldCount, buf, offset, version) {
    const result = {};
    let currentOffset = offset;

    for (let i = 0; i < fieldCount; i++) {
        if (currentOffset >= buf.length) {
            throw new Error('Unexpected end of buffer while reading field name');
        }
        const nameLen = buf.readUInt8(currentOffset);
        currentOffset += 1;

        if (currentOffset + nameLen + 1 > buf.length) {
            throw new Error('Buffer too short for field name and type');
        }

        const name = buf.toString('utf8', currentOffset, currentOffset + nameLen);
        currentOffset += nameLen;

        const typeCode = buf.readUInt8(currentOffset);
        currentOffset += 1;

        let value;
        if (typeCode === TYPE_INT) {
            if (currentOffset + 8 > buf.length) {
                throw new Error('Buffer too short for int64');
            }
            const big = buf.readBigInt64BE(currentOffset);
            currentOffset += 8;
            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
            if (big <= maxSafe && big >= minSafe) {
                value = Number(big);
            } else {
                value = big;
            }
        } else if (typeCode === TYPE_STRING) {
            const lenBytes = version === VERSION_V1 ? 2 : 4;
            if (currentOffset + lenBytes > buf.length) {
                throw new Error('Buffer too short for string length');
            }
            const len =
                version === VERSION_V1
                    ? buf.readUInt16BE(currentOffset)
                    : buf.readUInt32BE(currentOffset);
            currentOffset += lenBytes;
            if (currentOffset + len > buf.length) {
                throw new Error('Buffer too short for string data');
            }
            value = buf.toString('utf8', currentOffset, currentOffset + len);
            currentOffset += len;
        } else if (typeCode === TYPE_LIST) {
            const countBytes = version === VERSION_V1 ? 2 : 4;
            if (currentOffset + 1 + countBytes > buf.length) {
                throw new Error('Buffer too short for list header');
            }
            const elementType = buf.readUInt8(currentOffset);
            let elementCount;
            if (version === VERSION_V1) {
                elementCount = buf.readUInt16BE(currentOffset + 1);
            } else {
                elementCount = buf.readUInt32BE(currentOffset + 1);
            }
            currentOffset += 1 + countBytes;

            const arr = [];
            for (let j = 0; j < elementCount; j++) {
                if (elementType === TYPE_INT) {
                    if (currentOffset + 8 > buf.length) {
                        throw new Error('Buffer too short for list int element');
                    }
                    const big = buf.readBigInt64BE(currentOffset);
                    currentOffset += 8;
                    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
                    const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
                    if (big <= maxSafe && big >= minSafe) {
                        arr.push(Number(big));
                    } else {
                        arr.push(big);
                    }
                } else if (elementType === TYPE_STRING) {
                    const lenBytes = version === VERSION_V1 ? 2 : 4;
                    if (currentOffset + lenBytes > buf.length) {
                        throw new Error('Buffer too short for list string length');
                    }
                    const len =
                        version === VERSION_V1
                            ? buf.readUInt16BE(currentOffset)
                            : buf.readUInt32BE(currentOffset);
                    currentOffset += lenBytes;
                    if (currentOffset + len > buf.length) {
                        throw new Error('Buffer too short for list string data');
                    }
                    const s = buf.toString('utf8', currentOffset, currentOffset + len);
                    currentOffset += len;
                    arr.push(s);
                } else if (elementType === TYPE_OBJECT) {
                    const [objVal, newOffset] = decodeObject(buf, currentOffset, version);
                    currentOffset = newOffset;
                    arr.push(objVal);
                } else {
                    throw new Error(`Unsupported list element type: ${elementType}`);
                }
            }
            value = arr;
        } else if (typeCode === TYPE_OBJECT) {
            const [objVal, newOffset] = decodeObject(buf, currentOffset, version);
            currentOffset = newOffset;
            value = objVal;
        } else if (typeCode === TYPE_BYTES) {
            if (currentOffset + 4 > buf.length) {
                throw new Error('Buffer too short for bytes length');
            }
            const len = buf.readUInt32BE(currentOffset);
            currentOffset += 4;
            if (currentOffset + len > buf.length) {
                throw new Error('Buffer too short for bytes data');
            }
            value = buf.subarray(currentOffset, currentOffset + len);
            currentOffset += len;
        } else {
            throw new Error(`Unknown GalacticBuf type code: ${typeCode}`);
        }

        result[name] = value;
    }

    return [result, currentOffset];
}

function decodeObject(buf, offset, version) {
    if (offset >= buf.length) {
        throw new Error('Unexpected end of buffer while reading object field count');
    }
    const fieldCount = buf.readUInt8(offset);
    const [obj, newOffset] = decodeFields(fieldCount, buf, offset + 1, version);
    return [obj, newOffset];
}

module.exports = {
    encodeMessage,
    decodeMessage,
    listOfInts,
    listOfStrings,
    listOfObjects,
    bytes,
    TYPE_INT,
    TYPE_STRING,
    TYPE_LIST,
    TYPE_OBJECT,
    TYPE_BYTES,
    VERSION_V1,
    VERSION_V2
};
